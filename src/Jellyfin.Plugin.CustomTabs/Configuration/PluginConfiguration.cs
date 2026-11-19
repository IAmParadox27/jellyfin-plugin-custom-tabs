using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.CustomTabs.Configuration
{
    public class PluginConfiguration : BasePluginConfiguration
    {
        public TabConfig[] Tabs { get; set; } = Array.Empty<TabConfig>();

        // Disabled tabs keep their settings but are left out of the web
        // client entirely, so the remaining tabs keep contiguous indexes.
        public TabConfig[] GetEnabledTabs() => Tabs.Where(tab => tab.Enabled).ToArray();

        // Order of the header tabs, built-in and custom together. Entries are
        // "stock:<label>" for a Jellyfin tab (e.g. "stock:movies", matched on
        // its label) and "custom:<Id>" for a custom tab. Empty keeps the
        // default: custom tabs after the built-in ones.
        public string[] TabOrder { get; set; } = Array.Empty<string>();

        // Order of the icon buttons on the right of the header, Jellyfin's
        // own (and other plugins') and custom tabs placed there. Same key
        // format as TabOrder; native buttons are matched on their label
        // (aria-label or title). Empty keeps custom buttons before them.
        public string[] HeaderIconOrder { get; set; } = Array.Empty<string>();

        // Jellyfin's own tabs and header icons the admin has switched off in
        // the header, as "stock:<label>" keys. Custom tabs use their Enabled
        // flag instead.
        public string[] HiddenTabs { get; set; } = Array.Empty<string>();

        // Tabs left out of the side menu (the drawer on narrow screens), as
        // "stock:<label>" or "custom:<Id>" keys; independent of HiddenTabs
        public string[] HiddenDrawerTabs { get; set; } = Array.Empty<string>();

        public string[] HiddenHeaderIcons { get; set; } = Array.Empty<string>();

        // Per-tab changes to Jellyfin's own tabs (renamed, icon changed or
        // hidden, text hidden), keyed like TabOrder ("stock:<label>")
        public StockTabOverride[] TabOverrides { get; set; } = Array.Empty<StockTabOverride>();
    }

    public class StockTabOverride
    {
        public string Key { get; set; } = string.Empty;

        // Replacement label; empty keeps Jellyfin's
        public string Title { get; set; } = string.Empty;

        // Replacement icon: a Material icon name or an image URL (the image wins)
        public string Icon { get; set; } = string.Empty;

        public string ImageUrl { get; set; } = string.Empty;

        public bool HideTitle { get; set; }

        public bool HideIcon { get; set; }

        // Draw the image's shape in the theme's text colour
        public bool TintImage { get; set; }
    }

    public class TabConfig
    {
        public string ContentHtml { get; set; } = string.Empty;

        public string Title { get; set; } = string.Empty;

        // Stable id used by TabOrder; assigned by the settings page.
        public string Id { get; set; } = string.Empty;

        // Defaults to true so tabs saved before this setting existed stay on.
        public bool Enabled { get; set; } = true;

        // Material icon name shown on the tab, e.g. "movie" or "live_tv".
        public string Icon { get; set; } = string.Empty;

        // Image shown on the tab; takes priority over Icon when both are set.
        public string ImageUrl { get; set; } = string.Empty;

        // Draw the image's shape in the theme's text colour, like Jellyfin's
        // own icons, instead of its own colours (needs a transparent image)
        public bool TintImage { get; set; }

        // Show only the icon or image. Ignored when neither is set, so a tab
        // can never end up blank.
        public bool HideTitle { get; set; }

        // "" (default) puts the tab in the tab bar on the left; "Right" puts
        // it among the icon buttons on the right of the header instead.
        public string Placement { get; set; } = string.Empty;
    }
}