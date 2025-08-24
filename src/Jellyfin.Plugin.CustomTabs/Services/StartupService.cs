using System.Reflection;
using System.Runtime.Loader;
using Jellyfin.Plugin.CustomTabs.Helpers;
using Jellyfin.Plugin.CustomTabs.JellyfinVersionSpecific;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.CustomTabs.Services
{
    public class StartupService : IScheduledTask
    {
        public string Name => "Custom Tabs Startup";

        public string Key => "Jellyfin.Plugin.CustomTabs.Startup";
        
        public string Description => "Startup Service for Custom Tabs";
        
        public string Category => "Startup Services";

        private readonly ILogger<CustomTabsPlugin> m_logger;

        public StartupService(ILogger<CustomTabsPlugin> logger)
        {
            m_logger = logger;
        }

        public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            m_logger.LogInformation($"CustomTabs Startup. Registering file transformations.");
            
            List<JObject> payloads = new List<JObject>();

            {
                JObject payload = new JObject();
                payload.Add("id", "dcaafb64-88de-4efa-b77b-ae0616291cbb");
                payload.Add("fileNamePattern", "index.html");
                payload.Add("callbackAssembly", GetType().Assembly.FullName);
                payload.Add("callbackClass", typeof(TransformationPatches).FullName);
                payload.Add("callbackMethod", nameof(TransformationPatches.IndexHtml));
                
                payloads.Add(payload);
            }
            {
                JObject payload = new JObject();
                payload.Add("id", "403e6374-7433-4137-b24f-2be01a14a90f");
                payload.Add("fileNamePattern", "home-html\\..*\\.chunk\\.js");
                payload.Add("callbackAssembly", GetType().Assembly.FullName);
                payload.Add("callbackClass", typeof(TransformationPatches).FullName);
                payload.Add("callbackMethod", nameof(TransformationPatches.HomeHtmlChunk));
                
                payloads.Add(payload);
            }

            Assembly? fileTransformationAssembly =
                AssemblyLoadContext.All.SelectMany(x => x.Assemblies).FirstOrDefault(x =>
                    x.FullName?.Contains(".FileTransformation") ?? false);

            if (fileTransformationAssembly != null)
            {
                Type? pluginInterfaceType = fileTransformationAssembly.GetType("Jellyfin.Plugin.FileTransformation.PluginInterface");

                if (pluginInterfaceType != null)
                {
                    foreach (JObject payload in payloads)
                    {
                        pluginInterfaceType.GetMethod("RegisterTransformation")?.Invoke(null, new object?[] { payload });
                    }
                }
            }

            return Task.CompletedTask;
        }

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers() => StartupServiceHelper.GetDefaultTriggers();
    }
}