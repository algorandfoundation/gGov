import { useEffect, useReducer, useState } from 'react'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown, type MarkdownStorage } from 'tiptap-markdown'
import { Bold, Italic, Strikethrough, Heading2, List, ListOrdered, Link2, Code } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Separator } from '@/components/ui/separator'
import { MarkdownContent, proseClass } from '@/components/ui/markdown-content'
import { PromptDialog } from '@/components/ui/prompt-dialog'
import { cn } from '@/lib/utils'

/** tiptap-markdown doesn't augment TipTap's Storage type, so access it explicitly. */
function getMarkdown(editor: Editor): string {
  return (editor.storage as unknown as { markdown: MarkdownStorage }).markdown.getMarkdown()
}

interface MarkdownEditorProps {
  value: string
  onChange: (markdown: string) => void
  placeholder?: string
  id?: string
  className?: string
}

interface ToolbarButtonProps {
  onClick: () => void
  active?: boolean
  label: string
  children: React.ReactNode
}

function ToolbarButton({ onClick, active, label, children }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground [&_svg]:size-4',
        active && 'bg-accent text-accent-foreground',
      )}
    >
      {children}
    </button>
  )
}

function Toolbar({ editor }: { editor: Editor }) {
  const [linkOpen, setLinkOpen] = useState(false)

  function applyLink(url: string) {
    const trimmed = url.trim()
    if (trimmed === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      return
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: trimmed }).run()
  }

  return (
    <div className="flex flex-wrap items-center gap-0.5">
      <ToolbarButton
        label="Bold"
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold />
      </ToolbarButton>
      <ToolbarButton
        label="Italic"
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic />
      </ToolbarButton>
      <ToolbarButton
        label="Strikethrough"
        active={editor.isActive('strike')}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        <Strikethrough />
      </ToolbarButton>
      <ToolbarButton
        label="Inline code"
        active={editor.isActive('code')}
        onClick={() => editor.chain().focus().toggleCode().run()}
      >
        <Code />
      </ToolbarButton>
      <Separator orientation="vertical" className="mx-1 h-5" />
      <ToolbarButton
        label="Heading"
        active={editor.isActive('heading', { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 />
      </ToolbarButton>
      <ToolbarButton
        label="Bulleted list"
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        <List />
      </ToolbarButton>
      <ToolbarButton
        label="Numbered list"
        active={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered />
      </ToolbarButton>
      <Separator orientation="vertical" className="mx-1 h-5" />
      <ToolbarButton label="Link" active={editor.isActive('link')} onClick={() => setLinkOpen(true)}>
        <Link2 />
      </ToolbarButton>
      <PromptDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        title="Add link"
        description="Paste the URL this text should link to."
        label="Link URL"
        placeholder="https://"
        initialValue={(editor.getAttributes('link').href as string | undefined) ?? 'https://'}
        confirmLabel="Add link"
        onSubmit={applyLink}
      />
    </div>
  )
}

export function MarkdownEditor({ value, onChange, placeholder, id, className }: MarkdownEditorProps) {
  const [tab, setTab] = useState<'edit' | 'preview'>('edit')
  const [, forceUpdate] = useReducer((x) => x + 1, 0)

  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false } }), Markdown.configure({ html: false })],
    content: value,
    editorProps: {
      attributes: {
        id: id ?? '',
        class: cn(proseClass, 'min-h-[7rem] px-3 py-2 focus:outline-none'),
      },
    },
    onUpdate: ({ editor }) => onChange(getMarkdown(editor)),
  })

  // Re-render the toolbar so active states track the current selection.
  useEffect(() => {
    if (!editor) return
    const update = () => forceUpdate()
    editor.on('transaction', update)
    return () => {
      editor.off('transaction', update)
    }
  }, [editor])

  // Sync external value changes (e.g. forms seeded from fetched bodies) into the
  // editor, but never while the user is typing — avoids caret jumps / update loops.
  useEffect(() => {
    if (!editor || editor.isFocused) return
    if (value !== getMarkdown(editor)) {
      editor.commands.setContent(value || '')
    }
  }, [value, editor])

  const isEmpty = !value.trim()

  return (
    <div
      className={cn(
        'rounded-md border border-input bg-transparent shadow-sm focus-within:ring-1 focus-within:ring-ring',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-input p-1">
        {tab === 'edit' && editor ? <Toolbar editor={editor} /> : <div />}
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'edit' | 'preview')}>
          <TabsList className="h-7">
            <TabsTrigger value="edit" className="px-2 py-0.5 text-xs">
              Edit
            </TabsTrigger>
            <TabsTrigger value="preview" className="px-2 py-0.5 text-xs">
              Preview
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Keep the editor mounted across tab switches so its view isn't destroyed. */}
      <div className={cn('relative max-h-[24rem] overflow-y-auto', tab !== 'edit' && 'hidden')}>
        {isEmpty && placeholder && (
          <span className="pointer-events-none absolute left-3 top-2 text-sm text-muted-foreground">{placeholder}</span>
        )}
        <EditorContent editor={editor} />
      </div>

      {tab === 'preview' && (
        <div className="max-h-[24rem] min-h-[7rem] overflow-y-auto px-3 py-2">
          {isEmpty ? (
            <p className="text-sm text-muted-foreground">Nothing to preview.</p>
          ) : (
            <MarkdownContent>{value}</MarkdownContent>
          )}
        </div>
      )}
    </div>
  )
}
