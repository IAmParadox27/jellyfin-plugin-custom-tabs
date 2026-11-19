using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.CustomTabs.Configuration
{
    public class PluginConfiguration : BasePluginConfiguration
    {
        public TabConfig[] Tabs { get; set; } = Array.Empty<TabConfig>();
    }

    public class TabConfig
    {
        public string ContentHtml { get; set; } = string.Empty;

        public string Title { get; set; } = string.Empty;

        // Material icon name shown on the tab, e.g. "movie" or "live_tv".
        public string Icon { get; set; } = string.Empty;

        // Image shown on the tab; takes priority over Icon when both are set.
        public string ImageUrl { get; set; } = string.Empty;

        // Show only the icon or image. Ignored when neither is set, so a tab
        // can never end up blank.
        public bool HideTitle { get; set; }
    }
}