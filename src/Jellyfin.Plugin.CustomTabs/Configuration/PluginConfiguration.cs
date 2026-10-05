using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.CustomTabs.Configuration
{
    public class PluginConfiguration : BasePluginConfiguration
    {
        public TabConfig[] Tabs { get; set; } = Array.Empty<TabConfig>();
    }

    public class TabConfig
    {
        /// <summary>
        /// Permanent identifier of the tab, used in links (#/home?tab=N&amp;ctTab=Id) so a
        /// saved link keeps pointing at this tab when tabs are added, removed or reordered.
        /// Assigned by the plugin when a tab is saved without one.
        /// </summary>
        public string Id { get; set; } = string.Empty;

        public string ContentHtml { get; set; } = string.Empty;

        public string Title { get; set; } = string.Empty;
    }
}