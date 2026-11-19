using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.CustomTabs.Configuration
{
    public class PluginConfiguration : BasePluginConfiguration
    {
        public TabConfig[] Tabs { get; set; } = Array.Empty<TabConfig>();

        // Disabled tabs keep their settings but are left out of the web
        // client entirely, so the remaining tabs keep contiguous indexes.
        public TabConfig[] GetEnabledTabs() => Tabs.Where(tab => tab.Enabled).ToArray();
    }

    public class TabConfig
    {
        public string ContentHtml { get; set; } = string.Empty;

        public string Title { get; set; } = string.Empty;

        // Defaults to true so tabs saved before this setting existed stay on.
        public bool Enabled { get; set; } = true;

        // Material icon name shown on the tab, e.g. "movie" or "live_tv".
        public string Icon { get; set; } = string.Empty;

        // Image shown on the tab; takes priority over Icon when both are set.
        public string ImageUrl { get; set; } = string.Empty;

        // Show only the icon or image. Ignored when neither is set, so a tab
        // can never end up blank.
        public bool HideTitle { get; set; }

        // "" (default) puts the tab in the tab bar on the left; "Right" puts
        // it among the icon buttons on the right of the header instead.
        public string Placement { get; set; } = string.Empty;
    }
}