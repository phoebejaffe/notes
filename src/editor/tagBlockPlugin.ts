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
    actions.addAndStepInto($createTagBlockNode(tagName))
  },
}

const LexicalTagBlockVisitor: LexicalExportVisitor<TagBlockNode, any> = {
  testLexicalNode: $isTagBlockNode,
  visitLexicalNode({ lexicalNode, actions }) {
    actions.addAndStepInto('containerDirective', {
      name: 'tag',
      attributes: { name: lexicalNode.getTagName() },
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
