/**
 * Minimal ambient types for the Oh My Pi host package.
 *
 * The extension is loaded BY the host at runtime, so `@oh-my-pi/pi-coding-agent`
 * is not a dependency of this repo. Declaring the surface we actually use keeps
 * the extension type-checked without vendoring the host.
 *
 * Only the members jev-router touches are declared. Anything else on the real
 * API is deliberately absent so an accidental use fails the typecheck instead
 * of silently passing.
 */
declare module "@oh-my-pi/pi-coding-agent" {
	export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto";

	export type Model = {
		provider: string;
		id: string;
		name?: string;
		/** Input modalities the model accepts. Absent on custom/discovered models. */
		input?: readonly string[];
		/** Per-million-token rates. Absent on custom/discovered models. */
		cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
		contextWindow?: number | null;
	};

	/** Read-only model query facade exposed at `ctx.models`. */
	export type ExtensionModelQuery = {
		/** Authenticated models available this session. */
		list(): Model[];
		/** The current session model, if one is set. */
		current(): Model | undefined;
		/** Model string (`provider/id`, bare id) or role alias (`@tiny`) -> Model. */
		resolve(spec: string): Model | undefined;
		/** Opaque lineage token for "same family?" checks. */
		family(model: Model): string;
	};

	export type ExtensionUIContext = {
		setStatus?: (key: string, text?: string) => void;
		notify?: (message: string, type?: "info" | "warning" | "error") => void;
		confirm?: (title: string, message: string) => Promise<boolean>;
		input?: (title: string, placeholder?: string) => Promise<string | undefined>;
		setTitle?: (title: string) => void;
	};

	export type ExecResult = {
		stdout: string;
		stderr: string;
		code: number;
		killed?: boolean;
	};

	export type ExtensionContext = {
		cwd: string;
		hasUI: boolean;
		ui?: ExtensionUIContext;
		models?: ExtensionModelQuery;
		/** Read-only session facade. `getSessionId()` distinguishes the main session from each subagent's own session. */
		sessionManager?: { getSessionId: () => string };
		/** Context-window occupancy for the active model; `undefined` before the first response. */
		getContextUsage?: () => { tokens: number; contextWindow: number; percent: number } | undefined;
		/** Managed timers: a throw inside the callback cannot tear down the session. */
		setTimeout?: (fn: () => void, ms: number, ...args: unknown[]) => unknown;
		setInterval?: (fn: () => void, ms: number, ...args: unknown[]) => unknown;
		clearTimer?: (timer: unknown) => void;
		isIdle?: () => boolean;
	};

	/** Fired before a prompt (or a dequeued user batch) reaches the provider. */
	export type BeforeAgentStartEvent = {
		type: "before_agent_start";
		prompt: string;
		images?: unknown[];
		systemPrompt: string[];
	};

	export type EventMap = {
		before_agent_start: BeforeAgentStartEvent;
		session_start: { type: "session_start" };
		session_shutdown: { type: "session_shutdown" };
		tool_call: { type: "tool_call"; toolName: string; input?: Record<string, unknown> };
	};

	export type ExtensionCommandContext = ExtensionContext & {
		waitForIdle?: () => Promise<void>;
		reload?: () => Promise<void>;
	};

	export type ExtensionAPI = {
		/** Human-readable name shown in the extensions list. */
		setLabel: (label: string) => void;
		/** Schema builders provided by the host. */
		zod: unknown;
		arktype: (schema: unknown) => unknown;
		/** Subscribe to a lifecycle event. Handlers may be async. */
		on: <K extends keyof EventMap>(
			event: K,
			handler: (event: EventMap[K], ctx: ExtensionContext) => unknown | Promise<unknown>,
		) => void;
		registerCommand: (
			name: string,
			options: {
				description?: string;
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
			},
		) => void;
		/** Set the model for subsequent requests. Resolves false when no credential exists for it. */
		setModel: (model: Model) => Promise<boolean>;
		getThinkingLevel: () => ThinkingLevel | undefined;
		setThinkingLevel: (level: ThinkingLevel) => void;
		/** Persist a custom session entry (never sent to the model). */
		appendEntry: <T = unknown>(customType: string, data?: T) => void;
		exec: (command: string, args: string[], options?: Record<string, unknown>) => Promise<ExecResult>;
		logger?: { info?: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void };
	};
}
