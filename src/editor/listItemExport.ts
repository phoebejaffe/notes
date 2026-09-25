import { $createListItemNode, $isListItemNode, $isListNode } from '@lexical/list'
import { $isDecoratorNode, $isElementNode, $isLineBreakNode, $isTextNode } from 'lexical'

// Same as MDXEditor's list item visitors except `checked` comes from the item
// itself rather than the parent list type — otherwise every bullet in a list
// that happens to contain one task gains a `[ ]` marker on export (and a fake
// unchecked state on import).
export const ListItemCheckedImportVisitor = {
  testNode: 'listItem',
  visitNode({ mdastNode, actions }: any) {
    actions.addAndStepInto($createListItemNode(mdastNode.checked ?? undefined))
  },
}
export const ListItemCheckedVisitor = {
  testLexicalNode: $isListItemNode,
  visitLexicalNode({ lexicalNode, mdastParent, actions }: any) {
    const children = lexicalNode.getChildren()
    const firstChild = children[0]
    if (children.length === 1 && $isListNode(firstChild)) {
      const prevListItemNode = mdastParent.children.at(-1)
      if (!prevListItemNode) {
        actions.visitChildren(firstChild, mdastParent)
      } else {
        actions.visitChildren(lexicalNode, prevListItemNode)
      }
      return
    }
    const listItem = actions.appendToParent(mdastParent, {
      type: 'listItem',
      checked: lexicalNode.getChecked(),
      spread: false,
      children: [],
    })
    let surroundingParagraph: any = null
    for (const child of lexicalNode.getChildren()) {
      if ($isTextNode(child) || $isLineBreakNode(child) || (child.isInline() && ($isElementNode(child) || $isDecoratorNode(child)))) {
        surroundingParagraph ??= actions.appendToParent(listItem, { type: 'paragraph', children: [] })
        actions.visit(child, surroundingParagraph)
      } else {
        surroundingParagraph = null
        actions.visit(child, listItem)
      }
    }
  },
}
