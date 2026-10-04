using Jellyfin.Plugin.CustomTabs.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.CustomTabs;

public class CustomTabsPlugin : BasePlugin<PluginConfiguration>, IHasPluginConfiguration, IHasWebPages
{
    public override Guid Id => Guid.Parse("fbacd0b6-fd46-4a05-b0a4-2045d6a135b0");
    public override string Name => "Custom Tabs";
    
    public static CustomTabsPlugin Instance { get; private set; } = null!;
    
    public CustomTabsPlugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer) : base(applicationPaths, xmlSerializer)
    {
        Instance = this;

        // Configurations saved before tabs had ids get them once, here.
        if (AssignMissingIds(Configuration))
        {
            SaveConfiguration();
        }
    }

    public override void UpdateConfiguration(BasePluginConfiguration configuration)
    {
        // Covers every writer: this plugin's settings page, the API, and other
        // plugins that add entries (e.g. Jellyfin Enhanced) without an id.
        if (configuration is PluginConfiguration pluginConfiguration)
        {
            AssignMissingIds(pluginConfiguration);
        }

        base.UpdateConfiguration(configuration);
    }

    /// <summary>Gives every tab without a (unique) id a new one. Returns whether anything changed.</summary>
    private static bool AssignMissingIds(PluginConfiguration configuration)
    {
        bool changed = false;
        HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (TabConfig tab in configuration.Tabs ?? Array.Empty<TabConfig>())
        {
            if (string.IsNullOrWhiteSpace(tab.Id) || !seen.Add(tab.Id))
            {
                string id;
                do
                {
                    id = Guid.NewGuid().ToString("N").Substring(0, 8);
                }
                while (!seen.Add(id));

                tab.Id = id;
                changed = true;
            }
        }

        return changed;
    }

    public IEnumerable<PluginPageInfo> GetPages()
    {
        string? prefix = GetType().Namespace;

        yield return new PluginPageInfo
        {
            Name = Name,
            EmbeddedResourcePath = $"{prefix}.Configuration.config.html"
        };
    }
}