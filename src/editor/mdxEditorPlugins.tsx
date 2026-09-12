import { directivesPlugin, headingsPlugin, linkPlugin, listsPlugin, markdownShortcutPlugin, quotePlugin, realmPlugin, rootEditor$, tablePlugin, thematicBreakPlugin, toolbarPlugin, type DirectiveDescriptor } from '@mdxeditor/editor'
import type { LexicalEditor } from 'lexical'
import { DirectiveContentEditor } from './DirectiveContentEditor'
import { MdxEditorToolbar } from './MdxEditorToolbar'
import { tagBlockPlugin } from './tagBlockPlugin'

const directive = (name: string, attributes: string[] = []): DirectiveDescriptor => ({
  name,
  testNode: (node) => node.name === name,
  attributes,
  hasChildren: true,
  Editor: DirectiveContentEditor,
})

export const mdxDirectiveDescriptors = [directive('muted'), directive('custom-block', ['kind'])]

const lexicalEditorPlugin = (assign: (editor: LexicalEditor | null) => void) => realmPlugin({
  init(realm) {
    realm.sub(rootEditor$, assign)
  },
})()

export function mdxEditorPlugins(assignLexicalEditor: (editor: LexicalEditor | null) => void) {
  return [
    headingsPlugin(),
    listsPlugin(),
    quotePlugin(),
    linkPlugin(),
    tablePlugin(),
    thematicBreakPlugin(),
    markdownShortcutPlugin(),
    directivesPlugin({ directiveDescriptors: mdxDirectiveDescriptors }),
    tagBlockPlugin(),
    lexicalEditorPlugin(assignLexicalEditor),
    toolbarPlugin({ toolbarContents: () => <MdxEditorToolbar /> }),
  ]
}
