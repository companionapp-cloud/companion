import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as api from "./api";
import { styles as g } from "./theme";
import type { Account } from "./api";

// Account settings: change name, email, and password. Each block saves independently and
// reports its own success/error so one failing field doesn't clear the others.
export default function Settings(props: {
  account: Account;
  onBack: () => void;
  onAccountChanged: (a: Account) => void;
}) {
  return (
    <View style={s.container}>
      <Pressable onPress={props.onBack} style={s.back}>
        <Text style={g.link}>← Back</Text>
      </Pressable>
      <Text style={g.h1}>Account settings</Text>

      <NameBlock account={props.account} onAccountChanged={props.onAccountChanged} />
      <EmailBlock account={props.account} onAccountChanged={props.onAccountChanged} />
      <PasswordBlock />
    </View>
  );
}

// useSaver wraps a save action with busy/error/done state for a settings block.
function useSaver() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setDone(false);
    try {
      await fn();
      setDone(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, done, run };
}

function Block(props: { title: string; children: React.ReactNode }) {
  return (
    <View style={g.card}>
      <Text style={g.cardTitle}>{props.title}</Text>
      {props.children}
    </View>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  secureTextEntry?: boolean;
  placeholder?: string;
  keyboardType?: "email-address" | "default";
}) {
  return (
    <View>
      <Text style={g.label}>{props.label}</Text>
      <TextInput
        style={g.input}
        value={props.value}
        onChangeText={props.onChangeText}
        secureTextEntry={props.secureTextEntry}
        placeholder={props.placeholder}
        autoCapitalize="none"
        keyboardType={props.keyboardType ?? "default"}
      />
    </View>
  );
}

function SaveRow(props: { busy: boolean; error: string; done: boolean; onSave: () => void; label?: string }) {
  return (
    <View style={{ gap: 8 }}>
      {props.error ? <Text style={g.error}>{props.error}</Text> : null}
      {props.done ? <Text style={g.success}>Saved.</Text> : null}
      <Pressable style={[g.button, s.saveBtn]} onPress={props.onSave} disabled={props.busy}>
        <Text style={g.buttonText}>{props.busy ? "…" : props.label ?? "Save"}</Text>
      </Pressable>
    </View>
  );
}

function NameBlock(props: { account: Account; onAccountChanged: (a: Account) => void }) {
  const [first, setFirst] = useState(props.account.firstName);
  const [last, setLast] = useState(props.account.lastName);
  const saver = useSaver();
  return (
    <Block title="Name">
      <Field label="First name" value={first} onChangeText={setFirst} placeholder="First" />
      <Field label="Last name" value={last} onChangeText={setLast} placeholder="Last" />
      <SaveRow
        {...saver}
        onSave={() =>
          saver.run(async () => {
            await api.updateProfile(first, last);
            props.onAccountChanged({ ...props.account, firstName: first, lastName: last });
          })
        }
      />
    </Block>
  );
}

function EmailBlock(props: { account: Account; onAccountChanged: (a: Account) => void }) {
  const [email, setEmail] = useState(props.account.email);
  const saver = useSaver();
  return (
    <Block title="Email">
      <Field
        label="Email address"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        placeholder="you@example.com"
      />
      <SaveRow
        {...saver}
        label="Update email"
        onSave={() =>
          saver.run(async () => {
            await api.updateEmail(email);
            props.onAccountChanged({ ...props.account, email: email.trim().toLowerCase() });
          })
        }
      />
    </Block>
  );
}

function PasswordBlock() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const saver = useSaver();
  return (
    <Block title="Password">
      <Field label="Current password" value={current} onChangeText={setCurrent} secureTextEntry />
      <Field label="New password" value={next} onChangeText={setNext} secureTextEntry />
      <SaveRow
        {...saver}
        label="Change password"
        onSave={() =>
          saver.run(async () => {
            await api.updatePassword(current, next);
            setCurrent("");
            setNext("");
          })
        }
      />
    </Block>
  );
}

const s = StyleSheet.create({
  container: { width: 460, maxWidth: "100%", gap: 16, paddingVertical: 32, alignSelf: "center" },
  back: { alignSelf: "flex-start" },
  saveBtn: { alignSelf: "flex-start" },
});
