import { NestedLexicalEditor, type DirectiveEditorProps } from '@mdxeditor/editor'

export function DirectiveContentEditor({ mdastNode }: DirectiveEditorProps<any>) {
  const isTag = mdastNode.name === 'tag'
  const tagName = typeof mdastNode.attributes?.name === 'string' ? mdastNode.attributes.name : ''
  return <div className={isTag ? 'notes-tag-directive' : 'notes-custom-directive'} data-tag-tag={isTag ? tagName : undefined}>
    <NestedLexicalEditor<any>
      block
      getContent={(node) => (node as any).children as any}
      getUpdatedMdastNode={(node, children) => ({ ...(node as any), children })}
    />
  </div>
}
