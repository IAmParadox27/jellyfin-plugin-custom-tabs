using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.CustomTabs.Helpers
{
    // Stores tab images uploaded from the config page. Files live under the
    // plugin configurations folder, so they survive plugin updates, and are
    // named by a random id so the client never controls the path.
    public static class TabImageStore
    {
        public const string UrlPrefix = "CustomTabs/Images/";

        public const long MaxBytes = 2 * 1024 * 1024;

        private static readonly Regex FileNamePattern =
            new Regex("^[a-f0-9]{32}\\.(png|jpg|gif|webp|ico)$", RegexOptions.Compiled);

        public static string Folder => Path.Combine(
            CustomTabsPlugin.Instance.ConfigurationsPath, "CustomTabs", "images");

        public static bool IsValidFileName(string fileName) => FileNamePattern.IsMatch(fileName);

        // Identify the format from the file's own bytes rather than trusting
        // the upload's content type. SVG is deliberately not accepted: it can
        // carry scripts, and these files are served from the Jellyfin origin.
        public static string? DetectExtension(byte[] data)
        {
            if (data.Length >= 8 && data[0] == 0x89 && data[1] == 0x50 && data[2] == 0x4E && data[3] == 0x47)
            {
                return "png";
            }

            if (data.Length >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF)
            {
                return "jpg";
            }

            if (data.Length >= 6 && data[0] == 0x47 && data[1] == 0x49 && data[2] == 0x46 && data[3] == 0x38)
            {
                return "gif";
            }

            if (data.Length >= 12 && data[0] == 0x52 && data[1] == 0x49 && data[2] == 0x46 && data[3] == 0x46
                && data[8] == 0x57 && data[9] == 0x45 && data[10] == 0x42 && data[11] == 0x50)
            {
                return "webp";
            }

            if (data.Length >= 4 && data[0] == 0x00 && data[1] == 0x00 && data[2] == 0x01 && data[3] == 0x00)
            {
                return "ico";
            }

            return null;
        }

        public static string GetContentType(string fileName)
        {
            return Path.GetExtension(fileName) switch
            {
                ".png" => "image/png",
                ".jpg" => "image/jpeg",
                ".gif" => "image/gif",
                ".webp" => "image/webp",
                ".ico" => "image/x-icon",
                _ => "application/octet-stream"
            };
        }

        public static string Save(byte[] data, string extension)
        {
            Directory.CreateDirectory(Folder);
            string fileName = $"{Guid.NewGuid():N}.{extension}";
            File.WriteAllBytes(Path.Combine(Folder, fileName), data);
            return fileName;
        }

        // Deletes uploaded images that no tab points at any more, e.g. after a
        // tab is removed or its image replaced and the settings saved.
        public static void DeleteUnreferenced(IEnumerable<string> imageUrls)
        {
            if (!Directory.Exists(Folder))
            {
                return;
            }

            HashSet<string> keep = new HashSet<string>(
                imageUrls
                    .Where(url => !string.IsNullOrEmpty(url) && url.StartsWith(UrlPrefix, StringComparison.Ordinal))
                    .Select(url => url.Substring(UrlPrefix.Length)),
                StringComparer.Ordinal);

            foreach (string path in Directory.EnumerateFiles(Folder))
            {
                string fileName = Path.GetFileName(path);
                if (IsValidFileName(fileName) && !keep.Contains(fileName))
                {
                    try
                    {
                        File.Delete(path);
                    }
                    catch (IOException)
                    {
                        // Leave it for the next save
                    }
                }
            }
        }
    }
}
