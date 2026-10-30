import * as mdxEditor from '@mdxeditor/editor'
import { activeEditor$, directivesPlugin, exportVisitors$, headingsPlugin, importVisitors$, linkPlugin, listsPlugin, markdownShortcutPlugin, nestedEditorChildren$, quotePlugin, realmPlugin, rootEditor$, tablePlugin, thematicBreakPlugin, toolbarPlugin, type DirectiveDescriptor } from '@mdxeditor/editor'
import { CheckListPlugin } from '@lexical/react/LexicalCheckListPlugin'
import type { LexicalEditor } from 'lexical'
import type { ComponentType, RefObject } from 'react'
import { MdxEditorToolbar } from './MdxEditorToolbar'
import { DirectiveContentEditor } from './DirectiveContentEditor'
import { ListItemCheckedImportVisitor, ListItemCheckedVisitor } from './listItemExport'
import { tagBlockPlugin } from './tagBlockPlugin'

// composerChildren$ is exported at runtime but excluded from the public types.
const { composerChildren$ } = mdxEditor as unknown as { composerChildren$: typeof nestedEditorChildren$ }

// MDXEditor mounts the stock CheckListPlugin without options, which focuses the
// editor on every checkbox tap. On coarse-pointer devices that pops the iOS
// keyboard and loses the paste callout — swap in the same plugin with
// disableTakeFocusOnClick so tapping a checkbox just toggles it.
const swapCheckListPlugin = (children: ComponentType[]) => {
  const bound = CheckListPlugin.bind(null, {
    disableTakeFocusOnClick: window.matchMedia('(pointer: coarse)').matches,
  })
  return children.map((Child) => (Child === CheckListPlugin ? bound : Child))
}

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
        realm.pub(composerChildren$, swapCheckListPlugin(realm.getValue(composerChildren$) as ComponentType[]))
        realm.pub(nestedEditorChildren$, swapCheckListPlugin(realm.getValue(nestedEditorChildren$)))
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
