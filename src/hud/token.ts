import {
    BaseTokenContext,
    BaseTokenRenderOptions,
    BaseTokenSettings,
    PF2eHudBaseToken,
} from "./base/token";
import {
    AdvancedHudAnchor,
    AdvancedHudEvent,
    CLOSE_SETTINGS,
    CloseSetting,
    makeAdvancedHUD,
} from "./base/advanced";
import {
    StatsAdvanced,
    StatsHeaderExtras,
    getAdvancedStats,
    getStatsHeaderExtras,
} from "./shared/advanced";
import { StatsHeader, getStatsHeader } from "./shared/base";
import { SidebarMenu, SidebarName, SidebarSettings, getSidebars } from "./sidebar/base";
import { hud } from "../main";
import {
    R,
    addListenerAll,
    createHTMLElement,
    createHook,
    libWrapper,
    registerWrapper,
} from "foundry-pf2e";
import { addStatsAdvancedListeners, addStatsHeaderListeners } from "./shared/listeners";

const CLOSE_OPTIONS = ["never", "sidebar", "all"] as const;
const CLOSE_CHOICES = R.mapToObj(CLOSE_OPTIONS, (option) => [
    option,
    `pf2e-hud.token.closeChoices.${option}`,
]);

class PF2eHudToken extends makeAdvancedHUD(PF2eHudBaseToken<TokenSettings, TokenHudActor>) {
    #canvasPanHook = createHook("canvasPan", () => {
        this._updatePosition();
        this.sidebar?._updatePosition();
    });

    #mainElement: HTMLElement | null = null;
    #initialized = false;

    static DEFAULT_OPTIONS: Partial<ApplicationConfiguration> = {
        id: "pf2e-hud-token",
    };

    get SETTINGS_ORDER(): (keyof TokenSettings)[] {
        return [
            "enabled",
            "mode",
            "scaleDimensions",
            "fontSize",
            "sidebarFontSize",
            "sidebarHeight",
            "multiColumns",
            "closeAllOnCLick",
            "closeOnSendToChat",
            "closeOnSpell",
        ];
    }

    get SETTINGS() {
        return super.SETTINGS.concat([
            {
                key: "mode",
                type: String,
                choices: ["exploded", "left", "right"],
                default: "exploded",
                scope: "client",
                onChange: () => {
                    this.toggleSidebar(null);
                    this.render();
                },
            },
            {
                key: "scaleDimensions",
                type: Boolean,
                default: false,
                scope: "client",
                onChange: () => {
                    this.toggleSidebar(null);
                    this.render();
                },
            },
            {
                key: "closeAllOnCLick",
                type: Boolean,
                default: false,
                scope: "client",
            },
            ...CLOSE_SETTINGS.map(
                (key): SettingOptions => ({
                    key,
                    type: String,
                    choices: CLOSE_CHOICES,
                    default: "never",
                    scope: "client",
                })
            ),
        ]);
    }

    get key() {
        return "token";
    }

    get templates(): ["hud"] {
        return ["hud"];
    }

    get allowedActorTypes(): (ActorType | "creature")[] {
        return ["army", "creature", "hazard", "vehicle"];
    }

    get mainElement() {
        return this.#mainElement!;
    }

    get anchor(): AdvancedHudAnchor {
        const bounds = this.mainElement.getBoundingClientRect();
        return {
            x: bounds.x + bounds.width / 2,
            y: bounds.y + bounds.height / 2,
        };
    }

    _onEnable() {
        if (this.#initialized) return;

        const enabled = this.enabled;
        if (!enabled) return;

        super._onEnable(enabled);

        this.#initialized = true;

        const context = this;

        registerWrapper(
            "CONFIG.Token.objectClass.prototype._onClickLeft",
            function (
                this: TokenPF2e,
                wrapped: libWrapper.RegisterCallback,
                event: PIXI.FederatedMouseEvent
            ) {
                wrapped(event);
                if (event.shiftKey || event.ctrlKey || game.activeTool !== "select") return;
                if (this === context.token) context.close();
                else context.setToken(this);
            },
            "WRAPPER"
        );

        registerWrapper(
            "CONFIG.Token.objectClass.prototype._onDragLeftStart",
            function (
                this: TokenPF2e,
                wrapped: libWrapper.RegisterCallback,
                event: PIXI.FederatedEvent
            ) {
                wrapped(event);
                context.close();
            },
            "WRAPPER"
        );

        registerWrapper(
            "TokenLayer.prototype._onClickLeft",
            function (
                this: Canvas,
                wrapped: libWrapper.RegisterCallback,
                event: PIXI.FederatedMouseEvent
            ) {
                wrapped(event);
                context.#clickClose();
            },
            "WRAPPER"
        );

        Hooks.on("renderTokenHUD", () => {
            this.close();
        });

        Hooks.on("renderActorSheet", (sheet: ActorSheetPF2e) => {
            if (this.isCurrentActor(sheet.actor)) this.close();
        });
    }

    _onSetToken(token: TokenPF2e | null): void {
        this.render(true);
    }

    async _prepareContext(options: TokenRenderOptions): Promise<TokenContext | TokenContextBase> {
        const parentData = await super._prepareContext(options);
        if (!parentData.hasActor) return parentData;

        const actor = parentData.actor;
        const statsHeader = getStatsHeader(actor);
        if (!statsHeader.health) return parentData;

        const data: TokenContext = {
            ...parentData,
            ...statsHeader,
            ...getAdvancedStats(actor),
            ...getStatsHeaderExtras(actor),
            sidebars: getSidebars(actor),
            name: this.token.document.name,
        };

        return data;
    }

    async _renderHTML(context: Partial<TokenContext>, options: TokenRenderOptions) {
        if (!context.health) return "";
        return this.renderTemplate("hud", context);
    }

    _replaceHTML(result: string, content: HTMLElement, options: TokenRenderOptions) {
        content.style.setProperty("--font-size", `${options.fontSize}px`);

        const oldElement = this.#mainElement;
        const focusName = oldElement?.querySelector<HTMLInputElement>("input:focus")?.name;

        this.#mainElement = createHTMLElement("div", {
            id: "pf2e-hud-token-main",
            innerHTML: result,
        });

        const mode = this.getSetting("mode");

        if (mode === "exploded") {
            this.#mainElement.classList.add("exploded");
        } else {
            const classes = ["joined"];
            if (mode === "left") classes.push("left");

            const wrapper = createHTMLElement("div", {
                classes,
                children: this.#mainElement.children,
            });

            this.#mainElement.appendChild(wrapper);
        }

        if (focusName) {
            this.#mainElement
                .querySelector<HTMLInputElement>(`input[name="${focusName}"]`)
                ?.focus();
        }

        if (oldElement) oldElement.replaceWith(this.#mainElement);
        else content.appendChild(this.#mainElement);

        this.#activateListeners(content);
    }

    _insertElement(element: HTMLElement) {
        element.dataset.tooltipDirection = "UP";
        super._insertElement(element);
    }

    _onRender(context: ApplicationRenderContext, options: ApplicationRenderOptions) {
        this.#canvasPanHook.activate();
        this.sidebar?.render(true);
    }

    _onClose(options: ApplicationClosingOptions) {
        this.#mainElement = null;
        this.#canvasPanHook.disable();
        return super._onClose(options);
    }

    _updatePosition(position = {} as ApplicationPosition) {
        const token = this.token;
        const element = this.element;
        if (!element || !token) return position;

        const canvasPosition = canvas.primary.getGlobalPosition();
        const canvasDimensions = canvas.dimensions;
        const scale = canvas.stage.scale.x;
        const mainElement = this.mainElement;
        const scaleDimensions = this.getSetting("scaleDimensions");
        const usedScale = scaleDimensions ? 1 : scale;

        position.left = canvasPosition.x;
        position.top = canvasPosition.y;
        position.width = canvasDimensions.width;
        position.height = canvasDimensions.height;
        position.scale = scaleDimensions ? scale : 1;

        element.style.setProperty("left", `${canvasPosition.x}px`);
        element.style.setProperty("top", `${canvasPosition.y}px`);
        element.style.setProperty("width", `${canvasDimensions.width * usedScale}px`);
        element.style.setProperty("height", `${canvasDimensions.height * usedScale}px`);
        element.style.setProperty("transform", `scale(${position.scale})`);

        if (mainElement) {
            const tokenBounds = token.bounds;
            const tokenDimensions = token.document;
            const ratio = canvas.dimensions.size / 100;

            const mainLeft = tokenBounds.left * usedScale;
            const mainTop = tokenBounds.top * usedScale;
            const mainWidth = tokenDimensions.width * ratio * 100 * usedScale;
            const mainHeight = tokenDimensions.height * ratio * 100 * usedScale;

            mainElement.style.setProperty("left", `${mainLeft}px`);
            mainElement.style.setProperty("top", `${mainTop}px`);
            mainElement.style.setProperty("width", `${mainWidth}px`);
            mainElement.style.setProperty("height", `${mainHeight}px`);
        }

        return position;
    }

    setToken(token: TokenPF2e | null) {
        this.toggleSidebar(null);

        if (!token) return super.setToken(token);

        const actor = token?.actor;
        if (
            !actor?.isOwner ||
            actor.isOfType("loot", "party") ||
            actor.sheet.rendered ||
            hud.persistent.isCurrentActor(actor, true)
        ) {
            token = null;
        }

        super.setToken(token);
    }

    closeIf(event: AdvancedHudEvent) {
        const settingKey = this.eventToSetting(event);
        const setting = this.getSetting(settingKey);
        if (setting === "never") return false;

        if (setting === "all") {
            this.close();
        } else if (setting === "sidebar") {
            this.toggleSidebar(null);
        }

        return true;
    }

    #clickClose() {
        if (this.getSetting("closeAllOnCLick")) {
            this.close();
            return;
        }

        const focused = document.activeElement as HTMLElement;

        if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) {
            focused.blur();
        } else if (this.sidebar) {
            this.toggleSidebar(null);
        } else {
            this.close();
        }
    }

    #activateListeners(html: HTMLElement) {
        addStatsHeaderListeners(this.actor, html, this.token);
        addStatsAdvancedListeners(this.actor, html);

        addListenerAll(html, "[data-action='open-sidebar']:not(.disabled)", (event, el) => {
            const sidebar = el.dataset.sidebar as SidebarName;
            this.toggleSidebar(sidebar);
        });
    }
}

interface PF2eHudToken {
    get token(): TokenPF2e;
    get actor(): TokenHudActor;
}

type TokenHudActor = Exclude<ActorInstances[ActorType], LootPF2e | PartyPF2e>;

type TokenRenderOptions = BaseTokenRenderOptions;

type TokenContextBase = BaseTokenContext<TokenHudActor>;

type TokenContext = TokenContextBase &
    StatsHeader &
    StatsHeaderExtras &
    StatsAdvanced & {
        name: string;
        sidebars: SidebarMenu[];
    };

type TokenCloseOption = (typeof CLOSE_OPTIONS)[number];

type TokenSettings = BaseTokenSettings &
    Record<CloseSetting, TokenCloseOption> &
    SidebarSettings & {
        scaleDimensions: boolean;
        mode: "exploded" | "left" | "right";
        multiColumns: boolean;
        closeAllOnCLick: boolean;
    };

export { PF2eHudToken };