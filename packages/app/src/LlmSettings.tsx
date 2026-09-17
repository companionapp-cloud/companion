import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Badge, Button, colors, Divider, Icon, IconButton, icon, Input, radius, row, space, Text, useDensity } from "@companion/design-system";
import type { CreateLLMConfigInput, LLMConfig } from "@companion/core-bridge";
import { useCore } from "./CoreContext";
import { Segmented, SettingsField, SettingsNote } from "./settingsUi";

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
  const touch = useDensity() === "touch";

  return (
    <View style={styles.section}>
      {configs && configs.length > 0 ? (
        <View style={styles.stack}>
          <Text variant="eyebrow" tone="quaternary">
            Providers · {configs.length}
          </Text>
          <View style={styles.list}>
            {configs.map((c, i) => (
              <View key={c.id} style={[styles.row, { minHeight: touch ? row.touch : 32 }, i === configs.length - 1 ? null : styles.rowDivider]}>
                <Text variant="label" numberOfLines={1} style={styles.rowName}>
                  {c.name}
                </Text>
                {c.isDefault ? <Badge label="default" tone="accent" /> : null}
                <View style={{ flex: 1 }} />
                <Text variant="mono" tone="quaternary" numberOfLines={1}>
                  {c.provider === "anthropic" ? "anthropic" : c.scope === "device" ? "local" : "openai-compatible"}
                </Text>
                {!c.isDefault ? (
                  <Button label="Make default" variant="secondary" size={touch ? undefined : "sm"} onPress={() => setDefault(c.id)} />
                ) : null}
                <IconButton label={`Remove ${c.name}`} size={touch ? undefined : "sm"} onPress={() => remove(c.id)}>
                  <Icon name="trash" size={touch ? icon.lg : 13} color={colors.textTertiary} />
                </IconButton>
              </View>
            ))}
          </View>
        </View>
      ) : configs ? (
        <SettingsNote>No providers yet. Add a local model by URL, or a cloud provider with an API key.</SettingsNote>
      ) : null}

      <Divider />

      <Text variant="eyebrow" tone="quaternary">
        Add a provider
      </Text>
      <Segmented
        options={(Object.keys(PRESETS) as Kind[]).map((k) => ({ value: k, label: PRESETS[k].label }))}
        value={kind}
        onChange={pickKind}
      />

      <SettingsField label="Name">
        <View style={styles.control}>
          <Input value={name} onChangeText={setName} autoCapitalize="none" />
        </View>
      </SettingsField>
      {preset.configureUrl ? (
        <SettingsField label="Server URL" help="You’ll pick which model to use in the chat, from the models this server has installed.">
          <View style={styles.control}>
            <Input mono value={baseUrl} onChangeText={setBaseUrl} placeholder="http://localhost:11434/v1" autoCapitalize="none" />
          </View>
        </SettingsField>
      ) : (
        <SettingsField
          label="API key"
          help="Stored on this device (keychain on native, browser storage on web) and never in the database."
        >
          <View style={styles.control}>
            <Input mono value={apiKey} onChangeText={setApiKey} placeholder="sk-…" secureTextEntry autoCapitalize="none" />
          </View>
        </SettingsField>
      )}

      {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
      <View style={{ flexDirection: "row" }}>
        <Button label={busy ? "…" : "Add provider"} onPress={add} disabled={busy} icon={<Icon name="plus" size={icon.sm} color={colors.onAccent} />} />
      </View>
    </View>
  );
}

const styles = {
  section: { gap: space.xl },
  stack: { gap: space.md },
  control: { width: "100%" as const, maxWidth: 320 },
  list: { borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radius.lg, overflow: "hidden" as const },
  row: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.md, paddingLeft: space.ml, paddingRight: space.xs },
  rowName: { flexShrink: 1 },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
};
