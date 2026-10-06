import { $applyNodeReplacement, ElementNode, type LexicalNode, type NodeKey, type SerializedElementNode } from 'lexical'

export type SerializedTagBlockNode = SerializedElementNode & {
  tagName: string
  collapsed: boolean
  type: 'tag-block'
  version: 1
}

export class TagBlockNode extends ElementNode {
  __tagName: string
  __collapsed: boolean

  constructor(tagName: string, collapsed = false, key?: NodeKey) {
    super(key)
    this.__tagName = tagName
    this.__collapsed = collapsed
  }

  static getType(): string {
    return 'tag-block'
  }

  static clone(node: TagBlockNode): TagBlockNode {
    return new TagBlockNode(node.__tagName, node.__collapsed, node.__key)
  }

  getTagName(): string {
    return this.__tagName
  }

  setTagName(tagName: string): void {
    const self = this.getWritable()
    self.__tagName = tagName
  }

  getCollapsed(): boolean {
    return this.__collapsed
  }

  createDOM(): HTMLElement {
    const element = document.createElement('div')
    element.className = 'notes-tag-directive'
    element.setAttribute('data-tag-tag', this.__tagName)
    if (this.__collapsed) element.setAttribute('data-tag-collapsed', '')
    return element
  }

  updateDOM(prevNode: TagBlockNode, dom: HTMLElement): boolean {
    if (prevNode.__tagName !== this.__tagName) {
      dom.setAttribute('data-tag-tag', this.__tagName)
    }
    if (prevNode.__collapsed !== this.__collapsed) {
      if (this.__collapsed) dom.setAttribute('data-tag-collapsed', '')
      else dom.removeAttribute('data-tag-collapsed')
    }
    return false
  }

  static importJSON(serializedNode: SerializedTagBlockNode): TagBlockNode {
    return $createTagBlockNode(serializedNode.tagName, serializedNode.collapsed)
  }

  exportJSON(): SerializedTagBlockNode {
    return {
      ...super.exportJSON(),
      tagName: this.__tagName,
      collapsed: this.__collapsed,
      type: 'tag-block',
      version: 1,
    }
  }

  isInline(): boolean {
    return false
  }

  isShadowRoot(): boolean {
    return true
  }

  extractWithChild(): boolean {
    return true
  }
}

export function $createTagBlockNode(tagName: string, collapsed = false): TagBlockNode {
  return $applyNodeReplacement(new TagBlockNode(tagName, collapsed))
}

export function $isTagBlockNode(node: LexicalNode | null | undefined): node is TagBlockNode {
  return node instanceof TagBlockNode
}
