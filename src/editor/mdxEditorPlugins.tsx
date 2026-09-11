import { directivesPlugin, headingsPlugin, linkPlugin, listsPlugin, markdownShortcutPlugin, quotePlugin, tablePlugin, thematicBreakPlugin, toolbarPlugin, type DirectiveDescriptor } from '@mdxeditor/editor'
import { DirectiveContentEditor } from './DirectiveContentEditor'
import { MdxEditorToolbar } from './MdxEditorToolbar'

const directive = (name: string, attributes: string[] = []): DirectiveDescriptor => ({
  name,
  testNode: (node) => node.name === name,
  attributes,
  hasChildren: true,
  Editor: DirectiveContentEditor,
})

export const mdxDirectiveDescriptors = [directive('tag', ['name']), directive('muted'), directive('custom-block', ['kind'])]

export function mdxEditorPlugins() {
  return [
    headingsPlugin(),
    listsPlugin(),
    quotePlugin(),
    linkPlugin(),
    tablePlugin(),
    thematicBreakPlugin(),
    markdownShortcutPlugin(),
    directivesPlugin({ directiveDescriptors: mdxDirectiveDescriptors }),
    toolbarPlugin({ toolbarContents: () => <MdxEditorToolbar /> }),
  ]
}
