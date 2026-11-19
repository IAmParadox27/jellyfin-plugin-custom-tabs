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
        ConfigurationsPath = applicationPaths.PluginConfigurationsPath;
    }

    public string ConfigurationsPath { get; }

    public override void UpdateConfiguration(BasePluginConfiguration configuration)
    {
        base.UpdateConfiguration(configuration);

        if (configuration is PluginConfiguration config)
        {
            // Images can be used by custom tabs and by Jellyfin's own tabs
            Helpers.TabImageStore.DeleteUnreferenced(
                config.Tabs.Select(tab => tab.ImageUrl)
                    .Concat(config.TabOverrides.Select(tabOverride => tabOverride.ImageUrl)));
        }
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