import { useCallback, useEffect, useState } from "react";
import { Linking, View } from "react-native";
import {
  Badge,
  Button,
  colors,
  Divider,
  Icon,
  IconButton,
  icon,
  Input,
  radius,
  row,
  space,
  Spinner,
  Text,
  useDensity,
} from "@companion/design-system";
import {
  isCliRuntime,
  runtimeLabel,
  type Agent,
  type AgentRuntime,
  type DiscoveredAgent,
  type InstallAgentInput,
} from "@companion/core-bridge";
import { useDialogKeys } from "./ConfirmDialog";
import { useCore } from "./CoreContext";
import { Dialog } from "./Dialog";
import { CheckBox, Segmented, SettingsField, SettingsNote } from "./settingsUi";

// Settings › AI (PLAN-agents.md §6.1). Agents are installed, not configured: local tools found
// on this computer (Claude Code, Codex, Ollama, LM Studio) install with one tap and are hosted
// here; cloud APIs take a key; a raw OpenAI-compatible URL lives under Advanced. Shared by
// desktop, web and mobile — discovery just comes back empty where the shell cannot scan.

type AddTab = "local" | "cloud" | "advanced";
type CloudKind = "anthropic-api" | "openai-api";

/** Where a browser or phone user learns how to get the desktop app, which is what hosts local
 *  agents (PLAN-agents.md §0). */
const WEBSITE_URL = "https://companionapp.cloud";
const GET_APPS_URL = `${WEBSITE_URL}/docs/getting-the-apps`;

/** AgentsSettings lists the installed agents; "Add agent" opens the add flow in a dialog. */
export function AgentsSettings() {
  const { agents } = useCore();
  const [list, setList] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const reload = useCallback(() => {
    agents
      .list()
      .then(setList)
      .catch((e) => setError(String(e)));
  }, [agents]);
  useEffect(reload, [reload]);
  useEffect(() => agents.onChanged(reload), [agents, reload]);

  const touch = useDensity() === "touch";

  return (
    <View style={styles.section}>
      {list && list.length > 0 ? (
        <View style={styles.stack}>
          <Text variant="eyebrow" tone="quaternary">
            Installed agents · {list.length}
          </Text>
          <View style={styles.list}>
            {list.map((a, i) => (
              <AgentRow key={a.id} agent={a} last={i === list.length - 1} touch={touch} onError={setError} />
            ))}
          </View>
        </View>
      ) : list ? (
        <SettingsNote>
          No agents yet. Install one found on this computer, or connect a cloud API with a key. You’ll pick which model to
          use in the chat.
        </SettingsNote>
      ) : null}

      {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}

      <Divider />

      <View style={{ flexDirection: "row" }}>
        <Button
          label="Add agent"
          onPress={() => setAdding(true)}
          icon={<Icon name="plus" size={icon.sm} color={colors.onAccent} />}
        />
      </View>

      {adding ? (
        <AddAgent
          onDone={() => {
            setAdding(false);
            reload();
          }}
          onCancel={() => setAdding(false)}
          installedCount={list?.length ?? 0}
        />
      ) : null}
    </View>
  );
}

// --- installed list ---------------------------------------------------------

function AgentRow({ agent, last, touch, onError }: { agent: Agent; last: boolean; touch: boolean; onError: (e: string) => void }) {
  const { agents } = useCore();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(agent.name);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const cli = isCliRuntime(agent.runtime);
  const local = !!agent.hostDeviceId;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const where = local
    ? agent.hostedHere
      ? "this computer"
      : agent.hostName || "another device"
    : agent.runtime === "openai-compatible"
      ? "any device"
      : "cloud";
  const state = local && !agent.online ? "offline" : null;

  return (
    <View style={last ? null : styles.rowDivider}>
      <View style={[styles.row, { minHeight: touch ? row.touch : 32 }]}>
        <View style={[styles.dot, { backgroundColor: agent.online ? colors.success : colors.textQuaternary }]} />
        <Text variant="label" numberOfLines={1} style={styles.rowName}>
          {agent.name}
        </Text>
        {agent.isDefault ? <Badge label="default" tone="accent" /> : null}
        {state ? <Badge label={state} tone="neutral" /> : null}
        <View style={{ flex: 1 }} />
        <Text variant="mono" tone="quaternary" numberOfLines={1}>
          {runtimeLabel(agent.runtime)} · {where}
        </Text>
        <IconButton label={open ? `Close ${agent.name}` : `Edit ${agent.name}`} size={touch ? undefined : "sm"} onPress={() => setOpen((o) => !o)}>
          <Icon name={open ? "chevronDown" : "chevronRight"} size={touch ? icon.lg : 13} color={colors.textTertiary} />
        </IconButton>
      </View>
      {open ? (
        <View style={styles.detail}>
          <SettingsField label="Name">
            <View style={styles.inline}>
              <View style={styles.control}>
                <Input value={name} onChangeText={setName} autoCapitalize="none" />
              </View>
              <Button
                label="Rename"
                variant="secondary"
                size={touch ? undefined : "sm"}
                disabled={busy || !name.trim() || name.trim() === agent.name}
                onPress={() => run(() => agents.update(agent.id, { name: name.trim() }))}
              />
            </View>
          </SettingsField>
          {agent.runtime === "anthropic-api" || agent.runtime === "openai-api" ? (
            <SettingsField
              label="API key"
              help={
                agent.apiKeyEnc
                  ? "Synced to your other devices, end-to-end encrypted."
                  : agent.hasKey
                    ? "Stored on this device only."
                    : "Not on this device. Add the key to use this agent here."
              }
            >
              <View style={styles.inline}>
                <View style={styles.control}>
                  <Input mono value={apiKey} onChangeText={setApiKey} placeholder="Replace key…" secureTextEntry autoCapitalize="none" />
                </View>
                <Button
                  label="Save key"
                  variant="secondary"
                  size={touch ? undefined : "sm"}
                  disabled={busy || !apiKey.trim()}
                  onPress={() =>
                    run(async () => {
                      await agents.update(agent.id, { apiKey: apiKey.trim() });
                      setApiKey("");
                    })
                  }
                />
              </View>
            </SettingsField>
          ) : null}
          <SettingsField
            label="Permissions"
            help={
              cli
                ? "Write tools let the agent create and edit notes and tasks in Companion. System access lets it edit files in its own workspace folder and run commands on this computer — including when driven from your phone."
                : "Write tools let the agent create and edit notes and tasks. Off, it can only read and search."
            }
          >
            <View style={styles.stack}>
              <CheckBox
                checked={agent.allowWrite}
                label="Write tools: create and edit notes and tasks"
                onPress={() => run(() => agents.update(agent.id, { allowWrite: !agent.allowWrite }))}
              />
              {cli ? (
                <CheckBox
                  checked={agent.allowSystem}
                  label="System access: edit files and run commands on this computer"
                  onPress={() => run(() => agents.update(agent.id, { allowSystem: !agent.allowSystem }))}
                />
              ) : null}
            </View>
          </SettingsField>
          {local ? (
            <SettingsNote>
              Hosted by {agent.hostedHere ? "this computer" : agent.hostName || "another device"}
              {agent.binaryPath ? ` · ${agent.binaryPath}` : ""}
              {agent.binaryVersion ? ` · v${agent.binaryVersion}` : ""}
              {!agent.hostedHere ? ". It runs there; other devices chat with it through your sync server." : "."}
            </SettingsNote>
          ) : null}
          <View style={styles.inline}>
            {!agent.isDefault ? (
              <Button label="Make default" variant="secondary" size={touch ? undefined : "sm"} disabled={busy} onPress={() => run(() => agents.setDefault(agent.id))} />
            ) : null}
            <Button
              label="Remove"
              variant="danger"
              size={touch ? undefined : "sm"}
              disabled={busy}
              onPress={() => run(() => agents.remove(agent.id))}
              icon={<Icon name="trash" size={icon.sm} color={colors.onAccent} />}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

// --- add flow ---------------------------------------------------------------

function AddAgent({ onDone, onCancel, installedCount }: { onDone: () => void; onCancel: () => void; installedCount: number }) {
  const { agents, devices } = useCore();
  const [found, setFound] = useState<DiscoveredAgent[] | null>(null);
  const [scanning, setScanning] = useState(false);
  // canHost: this shell can run local agents (the desktop). A browser or phone can't, so its
  // first tab explains how to get the desktop app instead of scanning.
  const [canHost, setCanHost] = useState<boolean | null>(null);
  const [tab, setTab] = useState<AddTab | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    devices
      .this()
      .then((d) => setCanHost(d.canHost))
      .catch(() => setCanHost(false));
  }, [devices]);

  const scan = useCallback(() => {
    setScanning(true);
    agents
      .discover()
      .then(setFound)
      .catch((e) => {
        setError(String(e));
        setFound([]);
      })
      .finally(() => setScanning(false));
  }, [agents]);
  useEffect(scan, [scan]);

  // Land on the local tab: on the desktop it lists what was found; elsewhere it explains that
  // local agents live on the desktop app.
  useEffect(() => {
    if (canHost !== null && found !== null) setTab((cur) => cur ?? "local");
  }, [canHost, found]);

  const tabs: { value: AddTab; label: string }[] = [
    { value: "local", label: canHost ? "On this computer" : "On your computer" },
    { value: "cloud", label: "Cloud" },
    { value: "advanced", label: "Advanced" },
  ];

  const install = async (input: InstallAgentInput) => {
    setError(null);
    try {
      await agents.install({ ...input, isDefault: installedCount === 0 });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // esc closes. ⏎ is left alone: each tab has its own submit (or, for found tools, one Install
  // button per row), so there is no single thing for it to mean here.
  const hints = useDialogKeys({ onEscape: onCancel });

  // A dialog (PLAN-agents.md §6.1): the flow is three tabs deep and taller than the page that
  // opens it, and it is a detour from the list, not part of it. The body scrolls; Cancel stays put.
  return (
    <Dialog
      title="Add an agent"
      width={520}
      onClose={onCancel}
      footer={<Button label="Cancel" variant="ghost" kbd={hints ? "esc" : undefined} onPress={onCancel} />}
    >
      {tab === null ? (
        <View style={styles.inline}>
          <Spinner inline size={12} />
          <SettingsNote>Looking for AI tools on this computer…</SettingsNote>
        </View>
      ) : (
        <>
          <Segmented fill options={tabs} value={tab} onChange={setTab} />
          {tab === "local" && !canHost ? (
            <DesktopNeededTab installedCount={installedCount} />
          ) : tab === "local" ? (
            <LocalTab found={found ?? []} scanning={scanning} onRescan={scan} onInstall={install} />
          ) : tab === "cloud" ? (
            <CloudTab onInstall={install} />
          ) : (
            <AdvancedTab onInstall={install} />
          )}
          {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
        </>
      )}
    </Dialog>
  );
}

function LocalTab({
  found,
  scanning,
  onRescan,
  onInstall,
}: {
  found: DiscoveredAgent[];
  scanning: boolean;
  onRescan: () => void;
  onInstall: (input: InstallAgentInput) => Promise<void>;
}) {
  const touch = useDensity() === "touch";
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <View style={styles.stack}>
      <SettingsNote>
        Tools already installed on this computer. Installing one makes it an agent hosted here — your phone and browser can
        chat with it through your sync server while this computer is on.
      </SettingsNote>
      {found.length === 0 ? (
        <SettingsNote>
          Nothing found. Companion looks for Claude Code (`claude`), Codex CLI (`codex`), a running Ollama server, and LM Studio.
        </SettingsNote>
      ) : (
        <View style={styles.list}>
          {found.map((f, i) => {
            const installed = !!f.installedAgentId;
            const key = `${f.runtime}:${f.path}`;
            return (
              <View key={key} style={[styles.card, i === found.length - 1 ? null : styles.rowDivider]}>
                <View style={styles.cardHead}>
                  <Text variant="label">{f.name}</Text>
                  {f.version ? (
                    <Text variant="mono" tone="quaternary">
                      v{f.version}
                    </Text>
                  ) : null}
                  {f.status !== "ready" ? <Badge label={f.status.replace(/_/g, " ")} tone="neutral" /> : null}
                  <View style={{ flex: 1 }} />
                  {installed ? (
                    <Badge label="installed" tone="accent" />
                  ) : (
                    <Button
                      label={busy === key ? "…" : "Install"}
                      size={touch ? undefined : "sm"}
                      disabled={busy !== null || f.status === "unsupported_version"}
                      onPress={async () => {
                        setBusy(key);
                        try {
                          await onInstall(
                            isCliRuntime(f.runtime)
                              ? { runtime: f.runtime, name: f.name, binaryPath: f.path, binaryVersion: f.version }
                              : { runtime: f.runtime, name: f.name, baseUrl: f.path },
                          );
                        } finally {
                          setBusy(null);
                        }
                      }}
                    />
                  )}
                </View>
                <Text variant="mono" tone="quaternary" numberOfLines={1}>
                  {f.path}
                </Text>
                {f.detail ? <SettingsNote>{f.detail}</SettingsNote> : null}
                {f.models && f.models.length > 0 ? (
                  <SettingsNote>
                    {f.models.length} model{f.models.length === 1 ? "" : "s"}: {f.models.slice(0, 4).join(", ")}
                    {f.models.length > 4 ? "…" : ""}
                  </SettingsNote>
                ) : null}
              </View>
            );
          })}
        </View>
      )}
      <View style={styles.inline}>
        <Button
          label={scanning ? "Scanning…" : "Rescan"}
          variant="secondary"
          size={touch ? undefined : "sm"}
          disabled={scanning}
          onPress={onRescan}
          icon={<Icon name="refresh" size={icon.sm} color={colors.textSecondary} />}
        />
      </View>
    </View>
  );
}

/** DesktopNeededTab is the "On your computer" tab on shells that cannot host: the browser and
 *  the phone. It explains that Claude Code, Codex and Ollama run on the desktop app and reach
 *  this device through sync. */
function DesktopNeededTab({ installedCount }: { installedCount: number }) {
  const touch = useDensity() === "touch";
  const open = (url: string) => void Linking.openURL(url).catch(() => {});
  return (
    <View style={styles.stack}>
      <SettingsNote tone="secondary">
        Tools like Claude Code, Codex and Ollama run on your computer, not in a browser or on a phone. The Companion desktop
        app finds them, installs them as agents, and hosts them — then you can chat with them from here through your sync
        server while that computer is on.
      </SettingsNote>
      <View style={styles.steps}>
        <Text variant="caption" tone="secondary">
          1. Install the Companion desktop app on your Mac, Windows or Linux computer.
        </Text>
        <Text variant="caption" tone="secondary">
          2. Sign in to the same account on both devices (Settings › Sync).
        </Text>
        <Text variant="caption" tone="secondary">
          3. On the desktop, open Settings › AI › Add agent › On this computer and install what it finds. Those agents
          appear here automatically{installedCount > 0 ? " next to the ones you already have" : ""}.
        </Text>
      </View>
      <View style={styles.inline}>
        <Button
          label="Get the desktop app"
          size={touch ? undefined : "sm"}
          onPress={() => open(GET_APPS_URL)}
          icon={<Icon name="external" size={icon.sm} color={colors.onAccent} />}
        />
        <Button label="companionapp.cloud" variant="ghost" size={touch ? undefined : "sm"} onPress={() => open(WEBSITE_URL)} />
      </View>
    </View>
  );
}

function CloudTab({ onInstall }: { onInstall: (input: InstallAgentInput) => Promise<void> }) {
  const [kind, setKind] = useState<CloudKind>("anthropic-api");
  const [name, setName] = useState("Anthropic");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const pick = (k: CloudKind) => {
    setKind(k);
    setName(k === "anthropic-api" ? "Anthropic" : "OpenAI");
  };
  return (
    <View style={styles.stack}>
      <Segmented
        options={[
          { value: "anthropic-api" as const, label: "Anthropic" },
          { value: "openai-api" as const, label: "OpenAI" },
        ]}
        value={kind}
        onChange={pick}
      />
      <SettingsField label="Name">
        <View style={styles.control}>
          <Input value={name} onChangeText={setName} autoCapitalize="none" />
        </View>
      </SettingsField>
      <SettingsField
        label="API key"
        help="On an end-to-end encrypted account the key syncs to your other devices, encrypted. Otherwise it stays on this device."
      >
        <View style={styles.control}>
          <Input mono value={apiKey} onChangeText={setApiKey} placeholder="sk-…" secureTextEntry autoCapitalize="none" />
        </View>
      </SettingsField>
      <View style={{ flexDirection: "row" }}>
        <Button
          label={busy ? "…" : "Add agent"}
          disabled={busy || !apiKey.trim() || !name.trim()}
          onPress={async () => {
            setBusy(true);
            try {
              await onInstall({ runtime: kind, name: name.trim(), apiKey: apiKey.trim() });
              setApiKey("");
            } finally {
              setBusy(false);
            }
          }}
          icon={<Icon name="plus" size={icon.sm} color={colors.onAccent} />}
        />
      </View>
    </View>
  );
}

function AdvancedTab({ onInstall }: { onInstall: (input: InstallAgentInput) => Promise<void> }) {
  const [name, setName] = useState("Custom server");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const runtime: AgentRuntime = "openai-compatible";
  return (
    <View style={styles.stack}>
      <SettingsNote>
        Any server speaking the OpenAI Chat Completions API: Ollama on another machine on your network, LM Studio, vLLM,
        OpenRouter… Local servers found on this computer install from the first tab instead.
      </SettingsNote>
      <SettingsField label="Name">
        <View style={styles.control}>
          <Input value={name} onChangeText={setName} autoCapitalize="none" />
        </View>
      </SettingsField>
      <SettingsField label="Server URL" help="You’ll pick which model to use in the chat, from the models this server reports.">
        <View style={styles.control}>
          <Input mono value={baseUrl} onChangeText={setBaseUrl} placeholder="http://192.168.1.20:11434/v1" autoCapitalize="none" />
        </View>
      </SettingsField>
      <SettingsField label="API key (optional)">
        <View style={styles.control}>
          <Input mono value={apiKey} onChangeText={setApiKey} placeholder="Leave blank if the server needs none" secureTextEntry autoCapitalize="none" />
        </View>
      </SettingsField>
      <View style={{ flexDirection: "row" }}>
        <Button
          label={busy ? "…" : "Add agent"}
          disabled={busy || !baseUrl.trim() || !name.trim()}
          onPress={async () => {
            setBusy(true);
            try {
              await onInstall({ runtime, name: name.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || undefined });
            } finally {
              setBusy(false);
            }
          }}
          icon={<Icon name="plus" size={icon.sm} color={colors.onAccent} />}
        />
      </View>
    </View>
  );
}

const styles = {
  section: { gap: space.xl },
  stack: { gap: space.md },
  inline: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm, flexWrap: "wrap" as const },
  control: { width: "100%" as const, maxWidth: 320 },
  list: { borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radius.lg, overflow: "hidden" as const },
  row: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.md, paddingLeft: space.ml, paddingRight: space.xs },
  rowName: { flexShrink: 1 },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  dot: { width: 6, height: 6, borderRadius: 3 },
  detail: { gap: space.lg, paddingHorizontal: space.ml, paddingBottom: space.lg, paddingTop: space.xs },
  card: { gap: space.xs, padding: space.ml },
  steps: { gap: space.xs, paddingLeft: space.xs },
  cardHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm },
};
