/**
 * Exclude models from Pi's model picker and /scoped-models.
 * Workaround for https://github.com/earendil-works/pi/issues/10167.
 *
 * /disabled-models lists accessible models. Search and toggle individual entries,
 * use Tab to compose a regex rule, or Ctrl+R to inspect and remove rules (Delete).
 * Regexes match the full provider/model reference, case-sensitively, without flags.
 * Preview and confirm new rules before saving.
 *
 * Config: ~/.pi/agent/disabled-models.json (PI_DISABLED_MODELS_CONFIG overrides).
 * { "models": ["provider/model", "provider/*", "bare-id"], "regex": ["^provider/.*preview"] }
 * Rules are persistent, so newly discovered matching models are excluded too.
 *
 * Limits: filters apply at session_start, not initial model selection or --list-models.
 * The installer links this extension only on Omarchy hosts. Guarded private
 * registry.runtime bridges refresh availability and intercept models.setProvider
 * so exclusions survive catalog refresh/provider replacement. Original providers
 * are not mutated; session shutdown restores the store hook.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  Api,
  Credential,
  Model,
  MutableModels,
  Provider,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

interface Config {
  models: string[];
  regex: string[];
}
interface Rule {
  kind: "exact" | "glob" | "regex";
  pattern: string;
}
interface InstalledFilter {
  original: Provider;
  capture?: (models: readonly Model<Api>[]) => void;
}
type ProviderStore = Pick<MutableModels, "setProvider" | "getProviders">;
interface ProviderHook {
  originalSetProvider: ProviderStore["setProvider"];
  setProvider: ProviderStore["setProvider"];
  disabled?: (model: Model<Api>) => boolean;
  active: boolean;
  wrappers: WeakMap<Provider, Provider>;
}
const CONFIG_PATH =
  process.env.PI_DISABLED_MODELS_CONFIG ??
  join(homedir(), ".pi", "agent", "disabled-models.json");
const filters = new WeakMap<object, InstalledFilter>();
const hooks = new WeakMap<ProviderStore, ProviderHook>();
const reference = (model: Model<Api>) => `${model.provider}/${model.id}`;

function readConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return { models: [], regex: [] };
  const value: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object");
  const raw = value as Record<string, unknown>;
  const strings = (key: string): string[] => {
    if (raw[key] === undefined) return [];
    if (
      !Array.isArray(raw[key]) ||
      !raw[key].every((item: unknown) => typeof item === "string")
    ) {
      throw new Error(`Expected ${key} to be an array of strings`);
    }
    return [...new Set(raw[key] as string[])];
  };
  const config = { models: strings("models"), regex: strings("regex") };
  // Fail visibly rather than discarding malformed rules or overwriting them later.
  compileRules(config);
  return config;
}
function writeConfig(config: Config): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
function matches(model: Model<Api>, pattern: string): boolean {
  return (
    pattern === reference(model) ||
    pattern === model.id ||
    (pattern.endsWith("/*") && pattern.slice(0, -2) === model.provider)
  );
}
function compileRules(config: Config): (model: Model<Api>) => boolean {
  const regexes = config.regex.map((pattern) => new RegExp(pattern));
  return (model) =>
    config.models.some((pattern) => matches(model, pattern)) ||
    regexes.some((regex) => regex.test(reference(model)));
}
function rules(config: Config): Rule[] {
  return [
    ...config.models.map(
      (pattern): Rule => ({
        kind: pattern.endsWith("/*") ? "glob" : "exact",
        pattern,
      }),
    ),
    ...config.regex.map((pattern): Rule => ({ kind: "regex", pattern })),
  ];
}
function ruleMatches(model: Model<Api>, rule: Rule): boolean {
  return rule.kind === "regex"
    ? new RegExp(rule.pattern).test(reference(model))
    : matches(model, rule.pattern);
}
function getRuntime(ctx: ExtensionContext) {
  // Public registry.refresh() rebuilds providers and discards live filters.
  const runtime = (
    ctx.modelRegistry as unknown as {
      runtime?: {
        getAvailable?: (providerId?: string) => Promise<readonly Model<Api>[]>;
        models?: ProviderStore;
      };
    }
  ).runtime;
  if (typeof runtime?.getAvailable !== "function")
    throw new Error("This Pi version has no availability-only refresh");
  const store = runtime.models;
  if (
    typeof store?.setProvider !== "function" ||
    typeof store.getProviders !== "function"
  ) {
    throw new Error("This Pi version has no provider-installation hook");
  }
  return { store, getAvailable: runtime.getAvailable.bind(runtime) };
}
function wrapProvider(provider: Provider, hook: ProviderHook): Provider {
  const cached = hook.wrappers.get(provider);
  if (cached) return cached;
  const entry: InstalledFilter = { original: provider };
  const apply = (
    models: readonly Model<Api>[],
    credential: Credential | undefined,
  ) => {
    const passed = provider.filterModels
      ? provider.filterModels(models, credential)
      : models;
    entry.capture?.(passed);
    return hook.active && hook.disabled
      ? passed.filter((model) => !hook.disabled!(model))
      : passed;
  };
  // Keep the original provider (including builtin composition inputs) untouched.
  // Bind other methods to their original receiver, including class-based providers.
  const wrapped = new Proxy(provider, {
    get(target, property) {
      if (property === "filterModels") return apply;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  filters.set(wrapped, entry);
  hook.wrappers.set(provider, wrapped);
  hook.wrappers.set(wrapped, wrapped);
  return wrapped;
}
function ensureHook(store: ProviderStore): ProviderHook {
  const existing = hooks.get(store);
  if (existing) return existing;
  const hook: ProviderHook = {
    originalSetProvider: store.setProvider,
    setProvider: () => {},
    active: true,
    wrappers: new WeakMap(),
  };
  hook.setProvider = function (this: ProviderStore, provider) {
    const wrapped =
      hook.active && hook.disabled ? wrapProvider(provider, hook) : provider;
    hook.originalSetProvider.call(this, wrapped);
  };
  store.setProvider = hook.setProvider;
  hooks.set(store, hook);
  return hook;
}
async function removeHook(ctx: ExtensionContext): Promise<void> {
  const runtime = getRuntime(ctx);
  const hook = hooks.get(runtime.store);
  if (!hook) return;
  hook.active = false;
  hook.disabled = undefined;
  // Do not overwrite a hook another extension installed after ours. In that
  // case our link in the chain remains inert and delegates without wrapping.
  if (runtime.store.setProvider === hook.setProvider) {
    runtime.store.setProvider = hook.originalSetProvider;
  }
  for (const provider of runtime.store.getProviders()) {
    const installed = filters.get(provider);
    if (installed) runtime.store.setProvider(installed.original);
  }
  hooks.delete(runtime.store);
  await runtime.getAvailable();
}
async function applyDisabledModels(
  ctx: ExtensionContext,
  config: Config,
): Promise<void> {
  const runtime = getRuntime(ctx);
  const disabled = compileRules(config);
  const hook = ensureHook(runtime.store);
  hook.disabled =
    config.models.length || config.regex.length ? disabled : undefined;
  for (const provider of runtime.store.getProviders()) {
    const installed = filters.get(provider);
    if (!hook.disabled && installed)
      runtime.store.setProvider(installed.original);
    else if (hook.disabled && !installed) runtime.store.setProvider(provider);
  }
  await runtime.getAvailable();
}
async function getAccessibleModels(
  ctx: ExtensionContext,
): Promise<Model<Api>[]> {
  const runtime = getRuntime(ctx);
  const catalogs = await Promise.all(
    [...new Set(ctx.modelRegistry.getAll().map((model) => model.provider))].map(
      async (providerId) => {
        const provider = ctx.modelRegistry.getProvider(providerId);
        const installed = provider && filters.get(provider);
        if (!installed) return runtime.getAvailable(providerId);
        // Capture the original filter's output only after authentication. Exclusions
        // remain active for ordinary model pickers throughout this query.
        let accessible: readonly Model<Api>[] = [];
        const capture = (models: readonly Model<Api>[]) => {
          accessible = models;
        };
        installed.capture = capture;
        try {
          await runtime.getAvailable(providerId);
          return accessible;
        } finally {
          if (installed.capture === capture) delete installed.capture;
        }
      },
    ),
  );
  return catalogs
    .flat()
    .sort((a, b) => reference(a).localeCompare(reference(b)));
}

async function showSelector(ctx: ExtensionContext): Promise<void> {
  let config = readConfig();
  const models = await getAccessibleModels(ctx);
  await ctx.ui.custom((tui, theme, _kb, done) => {
    const input = new Input();
    type Mode = "search" | "regex" | "rules";
    let mode: Mode = "search";
    let returnMode: Mode = "search";
    let selected = 0;
    let message = "";
    let busy = false;
    let inspect: Rule | undefined;
    let pending: { rule: Rule; remove: boolean } | undefined;
    const rerender = () => tui.requestRender();
    const matchingModels = () => {
      if (inspect)
        return models.filter((model) => ruleMatches(model, inspect!));
      if (mode !== "regex")
        return fuzzyFilter(models, input.getValue(), reference);
      if (!input.getValue()) return [];
      return models.filter((model) =>
        new RegExp(input.getValue()).test(reference(model)),
      );
    };
    const visibleRules = () =>
      fuzzyFilter(
        rules(config),
        input.getValue(),
        (rule) => `${rule.kind} ${rule.pattern}`,
      );
    const reset = () => {
      selected = 0;
      message = "";
      inspect = undefined;
      pending = undefined;
    };
    const save = async (next: Config) => {
      busy = true;
      try {
        compileRules(next);
        writeConfig(next);
        config = next;
        message = "Rules saved.";
        try {
          await applyDisabledModels(ctx, config);
        } catch (error) {
          message = `Rules saved, but could not apply: ${String(error)}`;
        }
      } catch (error) {
        message = `Could not save: ${String(error)}`;
      } finally {
        busy = false;
        rerender();
      }
    };
    const changeRule = (rule: Rule, remove: boolean) => {
      const key = rule.kind === "regex" ? "regex" : "models";
      const next = { models: [...config.models], regex: [...config.regex] };
      next[key] = remove
        ? next[key].filter((pattern) => pattern !== rule.pattern)
        : [...new Set([...next[key], rule.pattern])];
      return save(next);
    };
    const activate = async () => {
      if (pending) {
        const action = pending;
        pending = undefined;
        await changeRule(action.rule, action.remove);
        if (
          action.remove &&
          !rules(config).some(
            (rule) =>
              rule.kind === action.rule.kind &&
              rule.pattern === action.rule.pattern,
          )
        ) {
          inspect = undefined;
          selected = 0;
          rerender();
        }
        return;
      }
      if (inspect) return;
      if (mode === "rules") {
        inspect = visibleRules()[selected];
        selected = 0;
        return;
      }
      let matches: Model<Api>[];
      try {
        matches = matchingModels();
      } catch (error) {
        message = `Invalid regex: ${String(error)}`;
        return;
      }
      if (mode === "regex") {
        const pattern = input.getValue();
        if (!pattern || matches.length === 0) {
          message = "Match at least one accessible model before saving.";
          return;
        }
        if (config.regex.includes(pattern)) {
          message = "That regex rule already exists.";
          return;
        }
        pending = { rule: { kind: "regex", pattern }, remove: false };
        return;
      }
      const model = matches[selected];
      if (!model) return;
      const blockers = rules(config).filter((rule) => ruleMatches(model, rule));
      const inherited = blockers.find(
        (rule) => rule.kind === "regex" || rule.pattern !== reference(model),
      );
      if (inherited) {
        message = `Disabled by ${inherited.kind}: ${inherited.pattern}. Ctrl+R manages rules.`;
        return;
      }
      await changeRule(
        { kind: "exact", pattern: reference(model) },
        blockers.length > 0,
      );
    };
    const component = {
      get focused() {
        return input.focused;
      },
      set focused(value: boolean) {
        input.focused = value;
      },
      render(width: number): string[] {
        const fit = (line: string) => truncateToWidth(line, Math.max(0, width));
        const lines = [
          theme.fg(
            "accent",
            theme.bold(
              `Disabled Models [${mode === "regex" ? "Regex" : mode === "rules" ? "Rules" : "Search"}]`,
            ),
          ),
          "",
        ];
        if (!inspect && !pending) lines.push(...input.render(width), "");
        let rows: { label: string; value: string; disabled?: boolean }[] = [];
        let matches: Model<Api>[] = [];
        let parseError = "";
        if (mode === "rules" && !inspect && !pending) {
          rows = visibleRules().map((rule) => ({
            label: `${rule.kind}  ${rule.pattern}`,
            value: `${models.filter((model) => ruleMatches(model, rule)).length} matches`,
          }));
        } else {
          try {
            matches = pending
              ? models.filter((model) => ruleMatches(model, pending!.rule))
              : matchingModels();
            const disabled = compileRules(config);
            rows = matches.map((model) => ({
              label: reference(model),
              value: disabled(model) ? "disabled" : "enabled",
              disabled: disabled(model),
            }));
          } catch (error) {
            parseError = `Invalid regex: ${String(error)}`;
          }
        }
        if (pending)
          lines.push(
            fit(
              theme.fg(
                "warning",
                `${pending.remove ? "Remove" : "Save"} ${pending.rule.kind}: ${pending.rule.pattern}?`,
              ),
            ),
            "",
          );
        if (inspect)
          lines.push(
            fit(theme.fg("accent", `${inspect.kind}: ${inspect.pattern}`)),
            "",
          );
        selected = Math.max(0, Math.min(selected, rows.length - 1));
        const height = Math.max(1, Math.min(12, tui.terminal.rows - 14));
        const start = Math.max(
          0,
          Math.min(selected - Math.floor(height / 2), rows.length - height),
        );
        const valueWidth = mode === "rules" && !inspect && !pending ? 12 : 8;
        const labelWidth = Math.max(0, width - valueWidth - 6);
        for (let i = start; i < Math.min(rows.length, start + height); i++) {
          const row = rows[i];
          const label = truncateToWidth(row.label, labelWidth);
          const padded =
            label + " ".repeat(Math.max(0, labelWidth - visibleWidth(label)));
          const isSelected = i === selected;
          const color =
            row.disabled === undefined
              ? "dim"
              : row.disabled
                ? "error"
                : "success";
          lines.push(
            fit(
              (isSelected ? theme.fg("accent", "> ") : "  ") +
                (isSelected ? theme.fg("accent", padded) : padded) +
                "  " +
                theme.fg(color, isSelected ? theme.bold(row.value) : row.value),
            ),
          );
        }
        if (parseError) lines.push(fit(theme.fg("error", parseError)));
        else if (!rows.length)
          lines.push(
            theme.fg(
              "dim",
              mode === "regex" && !input.getValue()
                ? "Enter a regex matching provider/model."
                : "No matches.",
            ),
          );
        lines.push(
          "",
          fit(
            theme.fg(
              "dim",
              `${rows.length ? selected + 1 : 0}/${rows.length} ${mode === "rules" && !inspect && !pending ? "rules" : "accessible matches"}`,
            ),
          ),
        );
        const row = rows[selected];
        if (row) {
          lines.push(fit(theme.fg("dim", row.label)));
          const model = matches[selected];
          if (model) {
            const reasons = rules(config).filter((rule) =>
              ruleMatches(model, rule),
            );
            if (reasons.length)
              lines.push(
                fit(
                  theme.fg(
                    "dim",
                    `Disabled by: ${reasons.map((rule) => `${rule.kind} ${rule.pattern}`).join(", ")}`,
                  ),
                ),
              );
          }
        }
        if (message) lines.push(fit(theme.fg("warning", message)));
        const hint = busy
          ? "Saving..."
          : pending
            ? "Enter: confirm · Esc: cancel"
            : inspect
              ? "Delete: remove rule · Esc: back"
              : mode === "rules"
                ? "Enter: inspect · Delete: remove · Ctrl+R / Esc: back"
                : mode === "regex"
                  ? "Enter: preview save · Tab: search · Ctrl+R: rules · Esc: back"
                  : "Enter: toggle · Tab: regex · Ctrl+R: rules · Esc: close";
        lines.push("", fit(theme.fg("dim", hint)));
        return lines.map(fit);
      },
      invalidate() {
        input.invalidate?.();
      },
      handleInput(data: string) {
        if (busy) return;
        if (matchesKey(data, Key.escape)) {
          if (pending) pending = undefined;
          else if (inspect) {
            inspect = undefined;
            selected = 0;
          } else if (mode === "rules") {
            mode = returnMode;
            input.setValue("");
            reset();
          } else if (mode === "regex") {
            mode = "search";
            input.setValue("");
            reset();
          } else done(undefined);
        } else if (matchesKey(data, Key.enter)) {
          void activate().catch((error) => {
            message = String(error);
            rerender();
          });
        } else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
          selected = Math.max(
            0,
            selected + (matchesKey(data, Key.up) ? -1 : 1),
          );
        } else if (pending) {
          // Allow preview scrolling, but not editing the expression being saved.
        } else if (matchesKey(data, Key.ctrl("r"))) {
          if (mode === "rules") mode = returnMode;
          else {
            returnMode = mode;
            mode = "rules";
          }
          input.setValue("");
          reset();
        } else if (matchesKey(data, Key.tab) && mode !== "rules") {
          mode = mode === "search" ? "regex" : "search";
          reset();
        } else if (matchesKey(data, Key.delete) && mode === "rules") {
          const rule = inspect ?? visibleRules()[selected];
          if (rule) pending = { rule, remove: true };
        } else if (!inspect) {
          input.handleInput(data);
          selected = 0;
          message = "";
        }
        rerender();
      },
    };
    return component;
  });
}
export default function disableModelsExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      await applyDisabledModels(ctx, readConfig());
    } catch (error) {
      ctx.ui.notify(`disable-models: ${String(error)}`, "error");
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    await removeHook(ctx);
  });
  pi.registerCommand("disabled-models", {
    description: "Manage model exclusions and regex rules",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/disabled-models requires TUI mode", "error");
        return;
      }
      try {
        await showSelector(ctx);
      } catch (error) {
        ctx.ui.notify(`disable-models: ${String(error)}`, "error");
      }
    },
  });
}
