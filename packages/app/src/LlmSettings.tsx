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

/** LlmSettings manages the user's chat providers (PLAN §6.8): add a local model by URL, or a
 *  cloud provider with an API key; list, set default, and remove. The model itself is not
 *  configured here — it's picked per chat from the provider's live model list. Shared across
 *  web/desktop (and reused by the mobile shell). */
export function LlmSettings() {
  const { llm } = useCore();
  const [configs, setConfigs] = useState<LLMConfig[] | null>(null);
  const [kind, setKind] = useState<Kind>("local");
  const [name, setName] = useState(PRESETS.local.name);
  const [baseUrl, setBaseUrl] = useState(PRESETS.local.baseUrl);
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
    setApiKey("");
    setError(null);
  };

  const add = useCallback(async () => {
    const p = PRESETS[kind];
    if (!name.trim() || (p.configureUrl && !baseUrl.trim()) || (p.needsKey && !apiKey.trim())) {
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
  }, [kind, name, baseUrl, apiKey, configs, llm, reload]);

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
                  {c.provider === "anthropic" ? "Anthropic" : c.scope === "device" ? "Local" : "OpenAI-compatible"}
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

      {error && (
        <Text tone="danger" variant="caption">
          {error}
        </Text>
      )}
      <View style={{ flexDirection: "row" }}>
        <Button label={busy ? "…" : "Add provider"} onPress={add} disabled={busy} icon={<Icon name="plus" size={15} />} />
      </View>
      <Text variant="caption" tone="tertiary">
        {preset.needsKey
          ? "Your key is stored on this device (keychain on native, browser storage on web) and never in the database."
          : "You'll pick which model to use in the chat, from the models this server has installed."}
      </Text>
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
};
