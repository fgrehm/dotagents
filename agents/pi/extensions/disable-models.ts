/**
 * Disable Models Extension
 *
 * Keeps selected models out of the model picker and `/scoped-models` by filtering each
 * provider's chat catalog after startup. This is a workaround for the feature request in
 * https://github.com/earendil-works/pi/issues/10167 until a `disabledModels` setting exists.
 *
 * Configuration lives in ~/.pi/agent/disabled-models.json (override with the
 * `PI_DISABLED_MODELS_CONFIG` environment variable):
 *
 *   { "models": ["opencode/gpt-6-luna", "opencode-go/*", "gpt-6-luna"] }
 *
 * Models covered by a wildcard or bare-ID pattern must be enabled by editing that
 * pattern in the JSON file; the selector will not silently change broad rules.
 *
 * An entry is "provider/model", a bare model id, or "provider/*".
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or load it with `pi -e disable-models.ts`.
 * 2. Edit the JSON file, or run `/disabled-models` in the TUI to toggle models.
 *
 * Caveats:
 * - The filter applies on `session_start`, so it does not affect the initial default model
 *   picked before the session exists, nor `pi --list-models`.
 * - It mutates the live provider's `filterModels`. Catalog refreshes and provider
 *   registration can recompose providers; the next `session_start` reapplies it.
 * - Availability refresh uses a guarded private registry.runtime.getAvailable() bridge.
 *   The public registry.refresh() would discard filters on composed providers.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, Credential, Model, Provider } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SettingItem,
  SettingsList,
} from "@earendil-works/pi-tui";

interface DisabledModelsConfig {
  models?: string[];
}

/** Idempotent per-provider filter state, stored on the live provider object. */
interface InstalledFilter {
  base: Provider["filterModels"];
  disabled: Set<string>;
  apply: NonNullable<Provider["filterModels"]>;
}

const CONFIG_PATH =
  process.env.PI_DISABLED_MODELS_CONFIG ??
  join(homedir(), ".pi", "agent", "disabled-models.json");

const filters = new WeakMap<object, InstalledFilter>();

function readPatterns(): string[] {
  try {
    if (!existsSync(CONFIG_PATH)) return [];
    const parsed = JSON.parse(
      readFileSync(CONFIG_PATH, "utf8"),
    ) as DisabledModelsConfig;
    return Array.isArray(parsed.models)
      ? parsed.models.filter((p): p is string => typeof p === "string")
      : [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`disable-models: could not read ${CONFIG_PATH}: ${message}`);
    return [];
  }
}

function writePatterns(patterns: readonly string[]): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(
    CONFIG_PATH,
    `${JSON.stringify({ models: [...patterns] }, null, 2)}\n`,
    "utf8",
  );
}

function matches(model: Model<Api>, pattern: string): boolean {
  if (pattern === `${model.provider}/${model.id}`) return true;
  if (pattern === model.id) return true;
  return pattern.endsWith("/*") && pattern.slice(0, -2) === model.provider;
}

/** Install or update a `filterModels` wrapper without stacking it across reapplications. */
function installFilter(provider: Provider, disabled: Set<string>): void {
  const existing = filters.get(provider);
  if (existing) {
    existing.disabled = disabled;
    return;
  }
  const entry: InstalledFilter = {
    base: provider.filterModels,
    disabled,
    apply: () => [],
  };
  entry.apply = (
    models: readonly Model<Api>[],
    credential: Credential | undefined,
  ) => {
    const passed = entry.base ? entry.base(models, credential) : models;
    return entry.disabled.size > 0
      ? passed.filter((model) => !entry.disabled.has(model.id))
      : passed;
  };
  provider.filterModels = entry.apply;
  filters.set(provider, entry);
}

function disabledIdsByProvider(
  ctx: ExtensionContext,
  patterns: readonly string[],
): Map<string, Set<string>> {
  const byProvider = new Map<string, Set<string>>();
  for (const model of ctx.modelRegistry.getAll()) {
    if (!patterns.some((pattern) => matches(model, pattern))) continue;
    const ids = byProvider.get(model.provider) ?? new Set<string>();
    ids.add(model.id);
    byProvider.set(model.provider, ids);
  }
  return byProvider;
}

/** Recompute the filter for every provider and refresh the availability snapshot. */
async function applyDisabledModels(
  ctx: ExtensionContext,
  patterns: readonly string[],
): Promise<void> {
  // Pi's public registry.refresh() recomposes configured providers, discarding
  // live filters. Use the runtime's availability-only refresh instead. This is
  // a private compatibility bridge, checked before any provider is modified.
  const runtime = (
    ctx.modelRegistry as unknown as {
      runtime?: { getAvailable?: () => Promise<readonly Model<Api>[]> };
    }
  ).runtime;
  if (typeof runtime?.getAvailable !== "function") {
    throw new Error(
      "disable-models: this Pi version has no availability-only refresh",
    );
  }
  const byProvider = disabledIdsByProvider(ctx, patterns);
  const providerIds = new Set([
    ...ctx.modelRegistry.getAll().map((model) => model.provider),
    ...byProvider.keys(),
  ]);
  for (const providerId of providerIds) {
    const provider = ctx.modelRegistry.getProvider(providerId);
    if (!provider) continue;
    const disabled = byProvider.get(providerId) ?? new Set<string>();
    const installed = filters.get(provider);
    if (disabled.size === 0) {
      // Restore the untouched provider once nothing is disabled for it.
      if (installed) {
        provider.filterModels = installed.base;
        filters.delete(provider);
      }
      continue;
    }
    installFilter(provider, disabled);
  }
  await runtime.getAvailable();
}

function buildItems(
  ctx: ExtensionContext,
  patterns: readonly string[],
): SettingItem[] {
  return [...ctx.modelRegistry.getAll()]
    .sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
    )
    .map((model) => {
      const reference = `${model.provider}/${model.id}`;
      return {
        id: reference,
        label: reference,
        currentValue: patterns.some((pattern) => matches(model, pattern))
          ? "disabled"
          : "enabled",
        values: ["enabled", "disabled"],
      };
    });
}

async function showDisabledModelsSelector(
  ctx: ExtensionContext,
): Promise<void> {
  const patterns = new Set(readPatterns());
  const items = buildItems(ctx, [...patterns]);
  if (items.length === 0) {
    ctx.ui.notify("No models available", "warning");
    return;
  }

  await ctx.ui.custom((tui, theme, _kb, done) => {
    const header = new (class {
      render(_width: number) {
        return [
          theme.fg("accent", theme.bold("Disabled Models")),
          theme.fg(
            "dim",
            "Type to search, Enter toggles a model. Changes save immediately.",
          ),
          "",
        ];
      }
      invalidate() {}
    })();

    const container = new Container();
    container.addChild(header);

    const list = new SettingsList(
      items,
      Math.min(items.length + 2, 20),
      getSettingsListTheme(),
      (id: string, newValue: string) => {
        const model = ctx.modelRegistry
          .getAll()
          .find((model) => `${model.provider}/${model.id}` === id);
        const previousValue =
          model && [...patterns].some((p) => matches(model, p))
            ? "disabled"
            : "enabled";
        const inherited =
          model &&
          [...patterns].find(
            (pattern) => pattern !== id && matches(model, pattern),
          );
        if (newValue === "enabled" && inherited) {
          list.updateValue(id, previousValue);
          ctx.ui.notify(
            `Disabled by "${inherited}". Edit ${CONFIG_PATH} to change that rule.`,
            "warning",
          );
          return;
        }
        const next = new Set(patterns);
        if (newValue === "disabled") next.add(id);
        else next.delete(id);
        try {
          writePatterns([...next]);
        } catch (error) {
          list.updateValue(id, previousValue);
          ctx.ui.notify(
            `Could not save ${CONFIG_PATH}: ${String(error)}`,
            "error",
          );
          return;
        }
        patterns.clear();
        for (const pattern of next) patterns.add(pattern);
        void applyDisabledModels(ctx, [...patterns]).catch((error) => {
          ctx.ui.notify(
            `Rules saved, but could not apply them: ${String(error)}`,
            "error",
          );
        });
      },
      () => done(undefined),
      { enableSearch: true },
    );
    container.addChild(list);

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        list.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
}

export default function disableModelsExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    await applyDisabledModels(ctx, readPatterns());
  });

  pi.registerCommand("disabled-models", {
    description: "Disable or enable models in the model picker",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/disabled-models requires TUI mode", "error");
        return;
      }
      await showDisabledModelsSelector(ctx);
    },
  });
}
