import { $applyNodeReplacement, ElementNode, type LexicalNode, type NodeKey, type SerializedElementNode } from 'lexical'

export type SerializedTagBlockNode = SerializedElementNode & {
  tagName: string
  type: 'tag-block'
  version: 1
}

export class TagBlockNode extends ElementNode {
  __tagName: string

  constructor(tagName: string, key?: NodeKey) {
    super(key)
    this.__tagName = tagName
  }

  static getType(): string {
    return 'tag-block'
  }

  static clone(node: TagBlockNode): TagBlockNode {
    return new TagBlockNode(node.__tagName, node.__key)
  }

  getTagName(): string {
    return this.__tagName
  }

  setTagName(tagName: string): void {
    const self = this.getWritable()
    self.__tagName = tagName
  }

  createDOM(): HTMLElement {
    const element = document.createElement('div')
    element.className = 'notes-tag-directive'
    element.setAttribute('data-tag-tag', this.__tagName)
    return element
  }

  updateDOM(prevNode: TagBlockNode, dom: HTMLElement): boolean {
    if (prevNode.__tagName !== this.__tagName) {
      dom.setAttribute('data-tag-tag', this.__tagName)
    }
    return false
  }

  static importJSON(serializedNode: SerializedTagBlockNode): TagBlockNode {
    return $createTagBlockNode(serializedNode.tagName)
  }

  exportJSON(): SerializedTagBlockNode {
    return {
      ...super.exportJSON(),
      tagName: this.__tagName,
      type: 'tag-block',
      version: 1,
    }
  }

  isInline(): boolean {
    return false
  }

  extractWithChild(): boolean {
    return true
  }
}

export function $createTagBlockNode(tagName: string): TagBlockNode {
  return $applyNodeReplacement(new TagBlockNode(tagName))
}

export function $isTagBlockNode(node: LexicalNode | null | undefined): node is TagBlockNode {
  return node instanceof TagBlockNode
}
