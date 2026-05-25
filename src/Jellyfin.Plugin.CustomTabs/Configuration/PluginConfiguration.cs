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

        public HostMapping[] Mappings { get; set; } = Array.Empty<HostMapping>();
    }

    public class HostMapping
    {
        public string Hostname { get; set; } = string.Empty;

        public string Url { get; set; } = string.Empty;
    }
}