using System.Reflection;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.CustomTabs.Configuration;
using Jellyfin.Plugin.CustomTabs.Model;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.CustomTabs.Helpers
{
    public static class TransformationPatches
    {
        // Whitespace inside the template, which sits in a JS string in the chunk:
        // real whitespace, or an escaped \n, \r or \t.
        private const string Gap = "(?:\\s|\\\\[nrt])";

        // The Favorites panel in jellyfin-web's Home template, which the custom
        // tab panels are inserted after. Whitespace-tolerant: themes and other
        // plugins re-format the template (#64).
        private static readonly Regex s_favoritesPanel = new Regex(
            $"id=\"favoritesTab\"{Gap}+data-index=\"1\"{Gap}*>{Gap}*<div{Gap}+class=\"sections\"{Gap}*>{Gap}*</div>{Gap}*</div>",
            RegexOptions.Compiled);

        /// <summary>Set by the startup task so a patch that finds nothing to patch can say so.</summary>
        public static ILogger? Logger { get; set; }

        public static string IndexHtml(PatchRequestPayload payload)
        {
            string contents = payload.Contents!;
            int bodyEnd = contents.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
            if (bodyEnd < 0)
            {
                // The registered file pattern also matches other files (e.g. the
                // session-login-index-html chunk); leave anything that is not the page alone.
                return contents;
            }

            Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream($"{typeof(CustomTabsPlugin).Namespace}.Inject.addCustomTabs.js")!;
            using TextReader reader = new StreamReader(stream);

            // Plain insertion, not a Regex replacement: the script must not be read as
            // a substitution pattern ($1, $& ...).
            return contents.Insert(bodyEnd, $"<script>{reader.ReadToEnd()}</script>");
        }

        public static string HomeHtmlChunk(PatchRequestPayload payload)
        {
            string buffer = payload.Contents!;
            {
                Stream stream = Assembly.GetExecutingAssembly()
                    .GetManifestResourceStream($"{typeof(CustomTabsPlugin).Namespace}.Inject.tabTemplate.html")!;
                using TextReader reader = new StreamReader(stream);

                string tabTemplate = reader.ReadToEnd();
                string finalReplacement = "";
                for (int i = 0; i < CustomTabsPlugin.Instance.Configuration.Tabs.Length; ++i)
                {
                    finalReplacement += tabTemplate
                        .Replace("{{tab_id}}", $"customTab_{i}")
                        .Replace("{{tab_index}}", $"{i + 2}")
                        .Replace("{{tab_content}}", "");
                }

                finalReplacement = finalReplacement
                    .Replace("'undefined'", "\\'undefined\\'");

                int matches = 0;
                buffer = s_favoritesPanel.Replace(buffer, match =>
                {
                    matches++;
                    return match.Value + finalReplacement;
                });

                if (matches == 0 && finalReplacement.Length > 0 && buffer.Contains("favoritesTab", StringComparison.Ordinal))
                {
                    // The client creates the panels itself when they are missing, so tabs
                    // still work; this only means the template has changed shape.
                    Logger?.LogWarning("Custom Tabs: could not find the Favorites panel in the Home template; tab panels will be created in the browser instead.");
                }
            }

            return buffer;
        }

        public static string MainBundle(PatchRequestPayload payload)
        {
            string replacementText =
                "window.PlaybackManager=this.playbackManager;console.log(\"PlaybackManager is now globally available:\",window.PlaybackManager);";
            
            string regex = Regex.Replace(payload.Contents!, @"(this\.playbackManager=e,)", $"$1{replacementText}");

            return regex;
        }
    }
}