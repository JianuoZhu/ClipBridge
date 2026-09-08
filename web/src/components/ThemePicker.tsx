import { useEffect, useState } from "react";
import { Check, Monitor, Moon, Palette, Sun } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { Button } from "./ui/button";

const themes = [
  ["system", "跟随系统", Monitor],
  ["mint", "薄荷", Sun],
  ["sky", "晴空", Sun],
  ["lavender", "薰衣草", Sun],
  ["forest", "松林", Moon],
  ["navy", "藏蓝", Moon],
  ["plum", "梅紫", Moon]
] as const;
type Theme = typeof themes[number][0];
const darkThemes: Theme[] = ["forest", "navy", "plum"];

function applyTheme(selected: Theme) {
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved: Theme = selected === "system" ? (systemDark ? "forest" : "mint") : selected;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.classList.toggle("dark", darkThemes.includes(resolved));
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
    "content", darkThemes.includes(resolved) ? "#111b18" : "#f4f8f6"
  );
}

export function ThemePicker() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const value = localStorage.getItem("clipbridge.theme") as Theme | null;
      return themes.some(([id]) => id === value) ? value! : "system";
    } catch { return "system"; }
  });
  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem("clipbridge.theme", theme); } catch {}
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => { if (theme === "system") applyTheme(theme); };
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [theme]);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label="切换主题" title="切换主题"><Palette size={18} /></Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="theme-menu" align="end" sideOffset={8}>
          <DropdownMenu.Label className="menu-label">外观</DropdownMenu.Label>
          {themes.map(([id, label, Icon]) => (
            <DropdownMenu.Item key={id} className="theme-option" onSelect={() => setTheme(id)}>
              <span className={"theme-swatch theme-swatch-" + id}><Icon size={14} /></span>
              <span>{label}</span>{theme === id && <Check className="theme-check" size={16} />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
