(function () {
  var themes = ["mint", "sky", "lavender", "forest", "navy", "plum"];
  var selected = "system";
  try { selected = localStorage.getItem("clipbridge.theme") || "system"; } catch (_) {}
  if (themes.indexOf(selected) < 0 && selected !== "system") selected = "system";
  var dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  var theme = selected === "system" ? (dark ? "forest" : "mint") : selected;
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", ["forest", "navy", "plum"].indexOf(theme) >= 0);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = ["forest", "navy", "plum"].indexOf(theme) >= 0 ? "#111b18" : "#f4f8f6";
})();
