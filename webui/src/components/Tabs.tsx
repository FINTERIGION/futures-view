export interface TabItem {
  key: string
  label: string
}

export function Tabs({
  items,
  active,
  onChange,
}: {
  items: TabItem[]
  active: string
  onChange: (key: string) => void
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={active === item.key}
          className={`tab ${active === item.key ? 'active' : ''}`}
          onClick={() => onChange(item.key)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
