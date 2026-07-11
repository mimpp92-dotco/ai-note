"use client";

import {
  type KeyboardEvent,
  type ReactNode,
  useId,
  useRef,
} from "react";

export interface TabItem<Value extends string> {
  value: Value;
  label: ReactNode;
  content: ReactNode;
}

export interface TabsProps<Value extends string> {
  id?: string;
  ariaLabel: string;
  items: readonly TabItem<Value>[];
  value: Value;
  onValueChange(value: Value): void;
  className?: string;
  panelClassName?: string;
}

// A deliberately bounded horizontal controlled tab primitive. Feature content and
// data ownership stay with the caller; this component owns only ARIA relationships,
// roving tabIndex, and automatic keyboard activation.
export function Tabs<Value extends string>({
  id,
  ariaLabel,
  items,
  value,
  onValueChange,
  className = "",
  panelClassName = "pt-5",
}: TabsProps<Value>) {
  const generatedId = useId().replace(/:/gu, "");
  const baseId = id ?? `tabs-${generatedId}`;
  const tabs = useRef(new Map<Value, HTMLButtonElement>());
  const selectedIndex = items.findIndex((item) => item.value === value);
  if (selectedIndex < 0) return null;
  const selected = items[selectedIndex];

  const activate = (index: number) => {
    const item = items[index];
    if (!item) return;
    onValueChange(item.value);
    tabs.current.get(item.value)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % items.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    activate(nextIndex);
  };

  return (
    <div className={className}>
      <div role="tablist" aria-label={ariaLabel} aria-orientation="horizontal" className="flex gap-1 border-b border-line">
        {items.map((item, index) => {
          const selectedItem = item.value === value;
          return (
            <button
              key={item.value}
              ref={(node) => {
                if (node) tabs.current.set(item.value, node);
                else tabs.current.delete(item.value);
              }}
              id={`${baseId}-tab-${index}`}
              type="button"
              role="tab"
              aria-controls={`${baseId}-panel-${index}`}
              aria-selected={selectedItem}
              tabIndex={selectedItem ? 0 : -1}
              onClick={(event) => {
                onValueChange(item.value);
                event.currentTarget.focus();
              }}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={`-mb-px min-h-11 border-b-2 px-4 py-2.5 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${
                selectedItem
                  ? "border-accent text-ink"
                  : "border-transparent text-inkSoft hover:text-ink"
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <div
        id={`${baseId}-panel-${selectedIndex}`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${selectedIndex}`}
        tabIndex={0}
        className={`${panelClassName} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2`}
      >
        {selected.content}
      </div>
    </div>
  );
}
