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
    }

    public IEnumerable<PluginPageInfo> GetPages()
    {
        string? prefix = GetType().Namespace;

        yield return new PluginPageInfo
        {
            Name = Name,
            EnableInMainMenu = true,
            EmbeddedResourcePath = $"{prefix}.Configuration.config.html"
        };
    }
}