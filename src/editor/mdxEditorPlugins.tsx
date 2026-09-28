import { activeEditor$, directivesPlugin, exportVisitors$, headingsPlugin, importVisitors$, linkPlugin, listsPlugin, markdownShortcutPlugin, quotePlugin, realmPlugin, rootEditor$, tablePlugin, thematicBreakPlugin, toolbarPlugin, type DirectiveDescriptor } from '@mdxeditor/editor'
import type { LexicalEditor } from 'lexical'
import type { RefObject } from 'react'
import { MdxEditorToolbar } from './MdxEditorToolbar'
import { DirectiveContentEditor } from './DirectiveContentEditor'
import { ListItemCheckedImportVisitor, ListItemCheckedVisitor } from './listItemExport'
import { tagBlockPlugin } from './tagBlockPlugin'

const DIRECTIVE_DESCRIPTORS: DirectiveDescriptor<any>[] = ['muted', 'custom-block'].map((name) => ({
  name,
  type: 'containerDirective' as const,
  testNode: (node) => node.type === 'containerDirective' && (node as { name?: string }).name === name,
  attributes: ['name'],
  hasChildren: true,
  Editor: DirectiveContentEditor,
}))

export function mdxEditorPlugins(lexicalEditorRef: RefObject<LexicalEditor | null>, activeEditorRef: RefObject<LexicalEditor | null>) {
  return [
    realmPlugin({
      postInit(realm) {
        lexicalEditorRef.current = realm.getValue(rootEditor$)
        realm.sub(activeEditor$, (editor) => { activeEditorRef.current = editor })
        realm.pub(exportVisitors$, [ListItemCheckedVisitor as never, ...realm.getValue(exportVisitors$)])
        realm.pub(importVisitors$, [ListItemCheckedImportVisitor as never, ...realm.getValue(importVisitors$)])
      },
    })(),
    headingsPlugin(),
    listsPlugin(),
    quotePlugin(),
    linkPlugin(),
    tablePlugin(),
    thematicBreakPlugin(),
    directivesPlugin({ directiveDescriptors: DIRECTIVE_DESCRIPTORS }),
    tagBlockPlugin(),
    markdownShortcutPlugin(),
    toolbarPlugin({ toolbarContents: () => <MdxEditorToolbar /> }),
  ]
}
