// The editor's cross-platform contract. `markdown` seeds the editor once (the editor
// owns its content thereafter); `onChangeMarkdown` reports serialized markdown back,
// debounced. The editor fills its parent, so size it from the outside.
export interface EditorProps {
  markdown: string;
  onChangeMarkdown: (markdown: string) => void;
}
