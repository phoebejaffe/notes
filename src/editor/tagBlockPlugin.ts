import {
  addExportVisitor$,
  addImportVisitor$,
  addLexicalNode$,
  realmPlugin,
  type LexicalExportVisitor,
  type MdastImportVisitor,
} from '@mdxeditor/editor'
import type { LexicalNode } from 'lexical'
import { $createTagBlockNode, $isTagBlockNode, TagBlockNode } from './TagBlockNode'

const MdastTagBlockVisitor: MdastImportVisitor<any> = {
  testNode: (node) => node.type === 'containerDirective' && node.name === 'tag',
  priority: 1,
  visitNode({ mdastNode, actions }) {
    const tagName = typeof mdastNode.attributes?.name === 'string' ? mdastNode.attributes.name : ''
    // A bare `collapsed` attribute parses to "", so check presence, not truthiness.
    const collapsed = 'collapsed' in (mdastNode.attributes ?? {}) && mdastNode.attributes.collapsed !== 'false'
    actions.addAndStepInto($createTagBlockNode(tagName, collapsed))
  },
}

const LexicalTagBlockVisitor: LexicalExportVisitor<TagBlockNode, any> = {
  testLexicalNode: $isTagBlockNode,
  visitLexicalNode({ lexicalNode, actions }) {
    actions.addAndStepInto('containerDirective', {
      name: 'tag',
      attributes: { name: lexicalNode.getTagName(), ...(lexicalNode.getCollapsed() ? { collapsed: 'true' } : {}) },
    })
  },
}

export const tagBlockPlugin = realmPlugin({
  init(realm) {
    realm.pubIn({
      [addLexicalNode$]: TagBlockNode,
      [addImportVisitor$]: MdastTagBlockVisitor,
      [addExportVisitor$]: LexicalTagBlockVisitor,
    })
  },
})

export { $createTagBlockNode, $isTagBlockNode, TagBlockNode }
export type { LexicalNode }
