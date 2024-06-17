import {
    ErrorPF2e,
    R,
    actorItems,
    addListenerAll,
    createSelfEffectMessage,
    elementDataset,
    getActionGlyph,
    getActiveModule,
    htmlClosest,
    htmlQuery,
    localize,
    objectHasKey,
    tupleHasValue,
} from "foundry-pf2e";
import { PF2eHudSidebar, SidebarContext, SidebarName, SidebarRenderOptions } from "./base";
import { PF2eHudTextPopup } from "../popup/text";
import { eventToRollMode, getActionIcon } from "foundry-pf2e/src/pf2e";

const ACTION_TYPES = {
    action: { sort: 0, label: "PF2E.ActionsActionsHeader" },
    reaction: { sort: 1, label: "PF2E.ActionsReactionsHeader" },
    free: { sort: 2, label: "PF2E.ActionsFreeActionsHeader" },
    passive: { sort: 3, label: "PF2E.NPC.PassivesLabel" },
    exploration: { sort: 3, label: "PF2E.TravelSpeed.ExplorationActivity" },
};

function getActionCategory(actor: ActorPF2e, item: WeaponPF2e<ActorPF2e> | MeleePF2e<ActorPF2e>) {
    if (item.isMelee) {
        const reach = actor.getReach({ action: "attack", weapon: item });

        return {
            type: "melee",
            tooltip: localize("sidebars.actions.reach", { reach }),
        };
    }

    const range = item.range!;
    const isThrown = item.isThrown;
    const key = isThrown ? "thrown" : range.increment ? "rangedWithIncrement" : "ranged";

    return {
        type: isThrown ? "thrown" : "ranged",
        tooltip: localize("sidebars.actions", key, range),
    };
}

async function getExtendedData(action: StrikeData, actor: ActorPF2e): Promise<ExtendedStrikeUsage> {
    return {
        ...action,
        damageFormula: String(await action.damage?.({ getFormula: true })),
        criticalFormula: String(await action.critical?.({ getFormula: true })),
        category: actor.isOfType("character") ? getActionCategory(actor, action.item) : undefined,
    };
}

class PF2eHudSidebarActions extends PF2eHudSidebar {
    get key(): SidebarName {
        return "actions";
    }

    async _prepareContext(options: SidebarRenderOptions): Promise<ActionsContext> {
        const actor = this.actor;
        const isCharacter = actor.isOfType("character");
        const parentData = await super._prepareContext(options);
        const rollData = actor.getRollData();
        const toolbelt = getActiveModule("pf2e-toolbelt");

        const stances = (() => {
            if (!isCharacter || !toolbelt?.getSetting("stances.enabled")) return;

            const actions = toolbelt.api.stances.getStances(actor);

            return {
                actions: R.sortBy(actions, R.prop("name")),
                canUse: toolbelt.api.stances.canUseStances(actor),
            };
        })();

        const blasts = await (async () => {
            if (!isCharacter) return;

            const blastData = new game.pf2e.ElementalBlast(actor);
            const reach =
                actor.attributes.reach.base +
                (blastData.infusion?.traits.melee.includes("reach") ? 5 : 0);

            return Promise.all(
                blastData.configs.map(async (config): Promise<ActionBlast> => {
                    const damageType =
                        config.damageTypes.find((dt) => dt.selected)?.value ?? "untyped";

                    const formulaFor = (
                        outcome: "success" | "criticalSuccess",
                        melee = true
                    ): Promise<string | null> =>
                        blastData.damage({
                            element: config.element,
                            damageType,
                            melee,
                            outcome,
                            getFormula: true,
                        });

                    return {
                        ...config,
                        reach: localize("sidebars.actions.reach", { reach }),
                        damageType,
                        formula: {
                            melee: {
                                damage: await formulaFor("success"),
                                critical: await formulaFor("criticalSuccess"),
                            },
                            ranged: {
                                damage: await formulaFor("success", false),
                                critical: await formulaFor("criticalSuccess", false),
                            },
                        },
                    };
                })
            );
        })();

        const strikes = await Promise.all(
            (actor.system.actions ?? []).map(
                async (strike, index): Promise<ExtendedStrike> => ({
                    ...(await getExtendedData(strike, actor)),
                    index,
                    visible: !isCharacter || (strike as CharacterStrike).visible,
                    description: await TextEditor.enrichHTML(strike.description, {
                        secrets: true,
                        rollData,
                    }),
                    altUsages: await Promise.all(
                        (strike.altUsages ?? []).map((altUsage) => getExtendedData(altUsage, actor))
                    ),
                })
            )
        );

        const heroActions = (() => {
            if (!isCharacter || !toolbelt?.getSetting("heroActions.enabled")) return;

            const api = toolbelt.api.heroActions;
            const actions = api.getHeroActions(actor);
            const usesCount = api.usesCountVariant();
            const heroPoints = actor.heroPoints.value;
            const diff = heroPoints - actions.length;
            const mustDiscard = !usesCount && diff < 0;
            const mustDraw = !usesCount && diff > 0;

            return {
                actions: R.sortBy(actions, R.prop("name")),
                usesCount,
                mustDiscard,
                mustDraw,
                canUse: (usesCount && heroPoints > 0) || diff >= 0,
                canTrade: actions.length && !mustDiscard && !mustDraw && api.canTrade(),
                diff: Math.abs(diff),
            };
        })();

        const actionSections = await (async () => {
            const abilityTypes: ("action" | "feat")[] = ["action"];
            if (isCharacter) abilityTypes.push("feat");

            const actionableEnabled = !!toolbelt?.getSetting("actionable.enabled");
            const excludedUUIDS = stances?.actions.map((x) => x.actionUUID) ?? [];
            const hasKineticAura =
                isCharacter &&
                actor.flags.pf2e.kineticist &&
                !!actor.itemTypes.effect.find((x) => x.slug === "effect-kinetic-aura");

            const inParty = isCharacter ? actor.parties.size > 0 : false;
            const explorations = isCharacter ? actor.system.exploration : [];
            const sections = {} as Record<
                ActionType | "exploration",
                { type: ActionType | "exploration"; label: string; actions: ActionData[] }
            >;

            const useLabel = game.i18n.localize("PF2E.Action.Use");

            for (const ability of actorItems(actor, abilityTypes)) {
                const sourceId = ability._stats.compendiumSource ?? ability.sourceId;
                const traits = ability.system.traits.value;
                const isExploration = isCharacter && traits.includes("exploration");

                if (
                    (ability.slug === "elemental-blast" && hasKineticAura) ||
                    (sourceId && excludedUUIDS.includes(sourceId)) ||
                    (ability.isOfType("feat") && !ability.actionCost) ||
                    traits.includes("downtime") ||
                    (!inParty && isExploration)
                )
                    continue;

                const id = ability.id;
                const actionCost = ability.actionCost;
                const type =
                    actionCost?.type ??
                    (isCharacter ? (isExploration ? "exploration" : "free") : "passive");

                sections[type] ??= {
                    type,
                    label: ACTION_TYPES[type].label,
                    actions: [],
                };

                const frequency = (() => {
                    const frequency = ability.frequency;
                    if (!frequency?.max) return;

                    const perLabel = game.i18n.localize(CONFIG.PF2E.frequencies[frequency.per]);

                    return {
                        max: frequency.max,
                        value: frequency.value,
                        label: `${frequency.max} / ${perLabel}`,
                    };
                })();

                const usage = await (async () => {
                    if (isExploration) return;
                    if (
                        !frequency &&
                        !ability.system.selfEffect &&
                        (!actionableEnabled ||
                            !(await toolbelt!.api.actionable.getActionMacro(ability)))
                    )
                        return;

                    const costIcon = getActionGlyph(actionCost);
                    const costLabel = `<span class="action-glyph">${costIcon}</span>`;

                    return {
                        disabled: frequency?.value === 0,
                        label: `${useLabel} ${costLabel}`,
                    };
                })();

                sections[type].actions.push({
                    id,
                    usage,
                    frequency,
                    name: ability.name,
                    img: getActionIcon(actionCost),
                    isActive: isExploration && explorations.includes(id),
                });
            }

            return R.pipe(
                sections,
                R.values(),
                R.sortBy((x) => ACTION_TYPES[x.type].sort),
                R.forEach((x) => (x.actions = R.sortBy(x.actions, R.prop("name"))))
            );
        })();

        const data: ActionsContext = {
            ...parentData,
            stances,
            heroActions,
            actionSections,
            blasts: blasts?.sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang)),
            strikes: strikes.sort((a, b) => a.index - b.index),
            isCharacter,
            variantLabel: (label: string) => label.replace(/.+\((.+)\)/, "$1"),
            showUnreadyStrikes: !!actor.getFlag("pf2e", "showUnreadyStrikes"),
        };

        return data;
    }

    _activateListeners(html: HTMLElement) {
        const actor = this.actor;
        const { elementTraits, damageTypes } = CONFIG.PF2E;

        const getBlast = (button: HTMLElement, itemRow: HTMLElement) => {
            const melee = button.dataset.melee === "true";
            const blast = new game.pf2e.ElementalBlast(actor as CharacterPF2e);
            const element = itemRow.dataset.element;
            const damageType = button.dataset.value || itemRow.dataset.damageType;

            if (!objectHasKey(elementTraits, element)) {
                throw ErrorPF2e("Unexpected error retrieve element");
            }
            if (!objectHasKey(damageTypes, damageType)) {
                throw ErrorPF2e("Unexpected error retrieving damage type");
            }

            return [blast, { element, damageType, melee }] as const;
        };

        const getStrike = <T extends StrikeData>(
            button: HTMLElement,
            readyOnly = false
        ): T | null => {
            const actionIndex = Number(htmlClosest(button, "[data-index]")?.dataset.index ?? "NaN");
            const rootAction = this.actor.system.actions?.at(actionIndex) ?? null;
            const altUsage = tupleHasValue(["thrown", "melee"], button?.dataset.altUsage)
                ? button?.dataset.altUsage
                : null;

            const strike = altUsage
                ? rootAction?.altUsages?.find((s) =>
                      altUsage === "thrown" ? s.item.isThrown : s.item.isMelee
                  ) ?? null
                : rootAction;

            return strike?.ready || !readyOnly ? (strike as T) : null;
        };

        const getUUID = (button: HTMLElement) => {
            return elementDataset(htmlClosest(button, ".item")!).uuid;
        };

        addListenerAll(html, "[data-action]", async (event, button) => {
            const itemRow = htmlClosest(button, ".item")!;
            const action = button.dataset.action as Action;

            switch (action) {
                case "blast-attack": {
                    const [blast, data] = getBlast(button, itemRow);
                    const mapIncreases = Math.clamp(Number(button.dataset.mapIncreases), 0, 2);
                    return blast.attack({ ...data, mapIncreases, event });
                }

                case "blast-damage": {
                    const [blast, data] = getBlast(button, itemRow);
                    const outcome =
                        button.dataset.outcome === "success" ? "success" : "criticalSuccess";
                    return blast.damage({ ...data, outcome, event });
                }

                case "blast-set-damage-type": {
                    const [blast, data] = getBlast(button, itemRow);
                    return blast.setDamageType(data);
                }

                case "strike-attack": {
                    const altUsage = tupleHasValue(["thrown", "melee"], button.dataset.altUsage)
                        ? button.dataset.altUsage
                        : null;

                    const strike = getStrike(button, true);
                    const variantIndex = Number(button.dataset.variantIndex);
                    return strike?.variants[variantIndex]?.roll({ event, altUsage });
                }

                case "strike-damage":
                case "strike-critical": {
                    const strike = getStrike(button);
                    const method =
                        button.dataset.action === "strike-damage" ? "damage" : "critical";
                    return strike?.[method]?.({ event });
                }

                case "auxiliary-action": {
                    const auxiliaryActionIndex = Number(button.dataset.auxiliaryActionIndex ?? NaN);
                    const strike = getStrike<CharacterStrike>(button);
                    const selection = htmlQuery(button, "select")?.value ?? null;
                    strike?.auxiliaryActions?.at(auxiliaryActionIndex)?.execute({ selection });
                    break;
                }

                case "toggle-weapon-trait": {
                    const weapon = getStrike<CharacterStrike>(button)?.item;
                    const trait = button.dataset.trait;
                    const errorMessage = "Unexpected failure while toggling weapon trait";

                    if (trait === "double-barrel") {
                        const selected = !weapon?.system.traits.toggles.doubleBarrel.selected;
                        if (!weapon?.traits.has("double-barrel")) throw ErrorPF2e(errorMessage);
                        return weapon.system.traits.toggles.update({ trait, selected });
                    } else if (trait === "versatile") {
                        const baseType = weapon?.system.damage.damageType ?? null;
                        const value = button.dataset.value;
                        const selected =
                            button.classList.contains("selected") || value === baseType
                                ? null
                                : value;
                        const selectionIsValid =
                            objectHasKey(CONFIG.PF2E.damageTypes, selected) || selected === null;
                        if (weapon && selectionIsValid) {
                            return weapon.system.traits.toggles.update({ trait, selected });
                        }
                    }

                    throw ErrorPF2e(errorMessage);
                }

                case "toggle-stance": {
                    const uuid = elementDataset(button).effectUuid;
                    getActiveModule("pf2e-toolbelt")?.api.stances.toggleStance(
                        actor as CharacterPF2e,
                        uuid,
                        event.ctrlKey
                    );
                    break;
                }

                case "hero-action-description": {
                    const details = await getActiveModule(
                        "pf2e-toolbelt"
                    )?.api.heroActions?.getHeroActionDetails(getUUID(button));
                    if (!details) return;
                    new PF2eHudTextPopup({
                        actor,
                        event,
                        content: details.description,
                        title: details.name,
                    }).render(true);
                    break;
                }

                case "hero-action-discard": {
                    getActiveModule("pf2e-toolbelt")?.api.heroActions.discardHeroActions(
                        actor as CharacterPF2e,
                        getUUID(button)
                    );
                    break;
                }

                case "hero-action-use": {
                    getActiveModule("pf2e-toolbelt")?.api.heroActions.useHeroAction(
                        actor as CharacterPF2e,
                        getUUID(button)
                    );
                    break;
                }

                case "hero-actions-draw": {
                    getActiveModule("pf2e-toolbelt")?.api.heroActions.drawHeroActions(
                        actor as CharacterPF2e
                    );
                    break;
                }

                case "hero-actions-trade": {
                    getActiveModule("pf2e-toolbelt")?.api.heroActions.tradeHeroAction(
                        actor as CharacterPF2e
                    );
                    break;
                }

                case "send-hero-action-to-chat": {
                    getActiveModule("pf2e-toolbelt")?.api.heroActions.sendActionToChat(
                        actor as CharacterPF2e,
                        getUUID(button)
                    );
                    break;
                }

                case "use-action": {
                    const itemId = elementDataset(htmlClosest(button, ".item")!).itemId;
                    const item = actor.items.get(itemId);
                    if (!item?.isOfType("feat", "action")) return;

                    const frequency = item.frequency;
                    if (frequency?.max && frequency.value) {
                        item.update({ "system.frequency.value": frequency.value - 1 });
                    }

                    if (item.system.selfEffect) {
                        createSelfEffectMessage(item, eventToRollMode(event));
                        return;
                    }

                    const toolbelt = getActiveModule("pf2e-toolbelt");
                    const macro = await toolbelt?.api.actionable.getActionMacro(item);
                    if (macro) {
                        macro?.execute({ actor });
                    }

                    if (!macro || toolbelt!.getSetting("actionable.message")) {
                        item.toMessage(event);
                    }

                    break;
                }
            }
        });

        addListenerAll(
            html,
            "select[data-action='link-ammo']",
            "change",
            (event, ammoSelect: HTMLSelectElement) => {
                event.stopPropagation();
                const action = getStrike<CharacterStrike>(ammoSelect);
                const weapon = action?.item;
                const ammo = this.actor.items.get(ammoSelect.value);
                weapon?.update({ system: { selectedAmmoId: ammo?.id ?? null } });
            }
        );

        addListenerAll(html, "[data-action='auxiliary-action'] select", (event, button) => {
            event.stopPropagation();
        });
    }
}

type Action =
    | "blast-attack"
    | "blast-damage"
    | "blast-set-damage-type"
    | "strike-attack"
    | "strike-damage"
    | "strike-critical"
    | "auxiliary-action"
    | "toggle-weapon-trait"
    | "toggle-stance"
    | "hero-actions-draw"
    | "hero-actions-trade"
    | "send-hero-action-to-chat"
    | "hero-action-description"
    | "hero-action-use"
    | "hero-action-discard"
    | "use-action";

type ActionData = {
    id: string;
    img: string;
    name: string;
    isActive: boolean;
    usage: Maybe<{
        disabled: boolean;
        label: string;
    }>;
    frequency: Maybe<{
        value: number;
        label: string;
    }>;
};

type ExtendedStrikeUsage = StrikeData & {
    damageFormula: string;
    criticalFormula: string;
    category: Maybe<{
        type: string;
        tooltip: string;
    }>;
};

type ExtendedStrike = ExtendedStrikeUsage & {
    index: number;
    visible: boolean;
    description: string;
    altUsages: ExtendedStrikeUsage[];
};

type ActionBlast = ElementalBlastSheetConfig & {
    reach: string;
};

type ActionsContext = SidebarContext & {
    isCharacter: boolean;
    showUnreadyStrikes: boolean;
    variantLabel: (label: string) => string;
    blasts: ActionBlast[] | undefined;
    strikes: ExtendedStrike[];
    actionSections: {
        type: "action" | "exploration" | "free" | "reaction" | "passive";
        label: string;
        actions: ActionData[];
    }[];
    stances: Maybe<{
        actions: toolbelt.stances.StanceData[];
        canUse: boolean;
    }>;
    heroActions: Maybe<{
        actions: toolbelt.heroActions.HeroActionFlag[];
        usesCount: boolean;
        mustDiscard: boolean;
        mustDraw: boolean;
        canUse: boolean;
        canTrade: boolean | 0;
        diff: number;
    }>;
};

export { PF2eHudSidebarActions };