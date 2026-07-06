import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Button, colors, Icon, IconButton, Input, radius, space, Text } from "@companion/design-system";
import type { CreateLLMConfigInput, LLMConfig } from "@companion/core-bridge";
import { useCore } from "./CoreContext";

type Kind = "local" | "openai" | "anthropic";

interface Preset {
  label: string;
  scope: CreateLLMConfigInput["scope"];
  provider: CreateLLMConfigInput["provider"];
  name: string;
  baseUrl: string;
  needsKey: boolean;
  /** local providers configure a URL; cloud providers configure a key. */
  configureUrl: boolean;
}

const PRESETS: Record<Kind, Preset> = {
  local: {
    label: "Ollama",
    scope: "device",
    provider: "openai-compatible",
    name: "Local (Ollama)",
    baseUrl: "http://localhost:11434/v1",
    needsKey: false,
    configureUrl: true,
  },
  openai: {
    label: "OpenAI",
    scope: "account",
    provider: "openai-compatible",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    needsKey: true,
    configureUrl: false,
  },
  anthropic: {
    label: "Anthropic",
    scope: "account",
    provider: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    needsKey: true,
    configureUrl: false,
  },
};

// Known models per provider. "Other…" always lets the user type one the list doesn't cover
// (a freshly pulled Ollama model, a preview snapshot, an org-specific deployment).
const MODELS: Record<Kind, string[]> = {
  local: ["qwen2.5", "qwen2.5-coder", "llama3.3", "llama3.1", "mistral-nemo", "firefunction-v2", "command-r"],
  openai: ["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4o", "gpt-4o-mini", "o4-mini", "o3"],
  anthropic: [
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-fable-5",
  ],
};

/** LlmSettings manages the user's chat providers (PLAN §6.8): add a local model by URL, or a
 *  cloud model with an API key; list, set default, and remove. Shared across web/desktop
 *  (and reusable by the mobile shell). */
export function LlmSettings() {
  const { llm } = useCore();
  const [configs, setConfigs] = useState<LLMConfig[] | null>(null);
  const [kind, setKind] = useState<Kind>("local");
  const [name, setName] = useState(PRESETS.local.name);
  const [baseUrl, setBaseUrl] = useState(PRESETS.local.baseUrl);
  const [model, setModel] = useState(MODELS.local[0]);
  const [otherModel, setOtherModel] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    llm.configs
      .list()
      .then(setConfigs)
      .catch((e) => setError(String(e)));
  }, [llm]);
  useEffect(reload, [reload]);

  const pickKind = (k: Kind) => {
    setKind(k);
    const p = PRESETS[k];
    setName(p.name);
    setBaseUrl(p.baseUrl);
    setModel(MODELS[k][0]);
    setOtherModel(false);
    setApiKey("");
    setError(null);
  };

  const add = useCallback(async () => {
    const p = PRESETS[kind];
    if (!name.trim() || !model.trim() || (p.configureUrl && !baseUrl.trim()) || (p.needsKey && !apiKey.trim())) {
      setError("Fill in the required fields.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await llm.configs.create({
        scope: p.scope,
        provider: p.provider,
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: p.needsKey ? apiKey.trim() : undefined,
        isDefault: (configs?.length ?? 0) === 0,
      });
      setApiKey("");
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [kind, name, baseUrl, model, apiKey, configs, llm, reload]);

  const setDefault = async (id: string) => {
    await llm.configs.setDefault(id).catch((e) => setError(String(e)));
    reload();
  };
  const remove = async (id: string) => {
    await llm.configs.remove(id).catch((e) => setError(String(e)));
    reload();
  };

  const preset = PRESETS[kind];

  return (
    <View style={{ gap: space.lg }}>
      {configs && configs.length > 0 && (
        <View style={{ gap: space.sm }}>
          {configs.map((c) => (
            <View key={c.id} style={styles.row}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={styles.nameRow}>
                  <Text numberOfLines={1} style={{ fontWeight: "600" }}>
                    {c.name}
                  </Text>
                  {c.isDefault && (
                    <View style={styles.badge}>
                      <Text variant="caption" tone="accent" style={{ fontWeight: "600" }}>
                        Default
                      </Text>
                    </View>
                  )}
                </View>
                <Text variant="caption" tone="tertiary" numberOfLines={1}>
                  {c.provider === "anthropic" ? "Anthropic" : c.scope === "device" ? "Local" : "OpenAI-compatible"} · {c.model}
                </Text>
              </View>
              {!c.isDefault && <Button label="Use" variant="secondary" size="sm" onPress={() => setDefault(c.id)} />}
              <IconButton label="Remove" size="sm" onPress={() => remove(c.id)}>
                <Icon name="trash" size={15} color={colors.textSecondary} />
              </IconButton>
            </View>
          ))}
        </View>
      )}

      <View style={styles.divider} />

      <Text variant="caption" tone="tertiary" style={{ fontWeight: "600" }}>
        Add a provider
      </Text>
      <View style={styles.kinds}>
        {(Object.keys(PRESETS) as Kind[]).map((k) => (
          <Pressable
            key={k}
            onPress={() => pickKind(k)}
            aria-label={PRESETS[k].label}
            style={[styles.pill, kind === k && styles.pillActive]}
          >
            <Text variant="caption" tone={kind === k ? "accent" : "secondary"} style={{ fontWeight: "600" }}>
              {PRESETS[k].label}
            </Text>
          </Pressable>
        ))}
      </View>

      <Field label="Name">
        <Input value={name} onChangeText={setName} autoCapitalize="none" />
      </Field>
      {preset.configureUrl ? (
        <Field label="Server URL">
          <Input value={baseUrl} onChangeText={setBaseUrl} placeholder="http://localhost:11434/v1" autoCapitalize="none" />
        </Field>
      ) : (
        <Field label="API key">
          <Input value={apiKey} onChangeText={setApiKey} placeholder="sk-…" secureTextEntry autoCapitalize="none" />
        </Field>
      )}
      <Field label="Model">
        <Select
          options={MODELS[kind]}
          value={otherModel ? null : model}
          onSelect={(m) => {
            setModel(m);
            setOtherModel(false);
          }}
          onOther={() => {
            setOtherModel(true);
            setModel("");
          }}
        />
        {otherModel && <Input value={model} onChangeText={setModel} placeholder="Model name" autoCapitalize="none" />}
      </Field>

      {error && (
        <Text tone="danger" variant="caption">
          {error}
        </Text>
      )}
      <View style={{ flexDirection: "row" }}>
        <Button label={busy ? "…" : "Add provider"} onPress={add} disabled={busy} icon={<Icon name="plus" size={15} />} />
      </View>
      {preset.needsKey && (
        <Text variant="caption" tone="tertiary">
          Your key is stored on this device (keychain on native, browser storage on web) and never in the database.
        </Text>
      )}
    </View>
  );
}

/** Select is an inline dropdown: a bordered field that expands to a list of options plus an
 *  "Other…" row. `value` is the chosen option, or null when "Other" is active. */
function Select({
  options,
  value,
  onSelect,
  onOther,
}: {
  options: string[];
  value: string | null;
  onSelect: (v: string) => void;
  onOther: () => void;
}) {
  const [open, setOpen] = useState(false);
  const isOther = value === null;
  return (
    <View>
      <Pressable style={styles.field} onPress={() => setOpen((o) => !o)} aria-label="Choose a model">
        <Text tone={isOther ? "tertiary" : undefined} style={{ flex: 1 }} numberOfLines={1}>
          {isOther ? "Other…" : value}
        </Text>
        <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
          <Icon name="chevronRight" size={16} color={colors.textTertiary} />
        </View>
      </Pressable>
      {open && (
        <View style={styles.menu}>
          {options.map((opt) => (
            <Pressable
              key={opt}
              style={styles.option}
              aria-label={opt}
              onPress={() => {
                onSelect(opt);
                setOpen(false);
              }}
            >
              <Text style={{ flex: 1 }}>{opt}</Text>
              {!isOther && opt === value && <Icon name="check" size={15} color={colors.accent} />}
            </Pressable>
          ))}
          <Pressable
            style={styles.option}
            aria-label="Other"
            onPress={() => {
              onOther();
              setOpen(false);
            }}
          >
            <Text tone="secondary" style={{ flex: 1 }}>
              Other…
            </Text>
            {isOther && <Icon name="check" size={15} color={colors.accent} />}
          </Pressable>
        </View>
      )}
    </View>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: space.sm }}>
      <Text variant="caption" tone="tertiary" style={{ fontWeight: "600" }}>
        {label}
      </Text>
      {children}
    </View>
  );
}

const styles = {
  row: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.md },
  nameRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm },
  badge: {
    paddingHorizontal: space.sm,
    paddingVertical: 1,
    backgroundColor: colors.accentSoft,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.accentSoftBorder,
  },
  divider: { height: 1, backgroundColor: colors.borderSubtle },
  kinds: { flexDirection: "row" as const, gap: space.sm },
  pill: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceApp,
  },
  pillActive: { backgroundColor: colors.accentSoft, borderColor: colors.accentSoftBorder },
  field: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.sm,
    paddingHorizontal: space.lg,
    height: 36,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceApp,
  },
  menu: {
    marginTop: space.xs,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceCard,
    overflow: "hidden" as const,
  },
  option: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
};
