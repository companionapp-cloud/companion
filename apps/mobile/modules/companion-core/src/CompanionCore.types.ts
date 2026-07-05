// One core event: an event name plus its JSON-encoded payload string, as emitted by
// the Go core's EventHandler.OnEvent and forwarded by the native module.
export type CoreEvent = {
  name: string;
  payload: string;
};

export type CompanionCoreModuleEvents = {
  onCoreEvent: (event: CoreEvent) => void;
};
