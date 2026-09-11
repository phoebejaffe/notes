import { NESTED_EDITOR_UPDATED_COMMAND, NestedLexicalEditor, useNestedEditorContext, type DirectiveEditorProps } from '@mdxeditor/editor'

export function DirectiveContentEditor(_props: DirectiveEditorProps<any>) {
  const { parentEditor } = useNestedEditorContext()

  return <div className="notes-custom-directive">
    <NestedLexicalEditor<any>
      block
      contentEditableProps={{ onInput: () => {
        parentEditor.dispatchCommand(NESTED_EDITOR_UPDATED_COMMAND, undefined)
      } }}
      getContent={(node) => (node as any).children as any}
      getUpdatedMdastNode={(node, children) => ({ ...(node as any), children })}
    />
  </div>
}
