using Jellyfin.Plugin.CustomTabs.Configuration;
using Jellyfin.Plugin.CustomTabs.Helpers;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.CustomTabs.Controller
{
    [ApiController]
    [Route("[controller]")]
    public class CustomTabsController : ControllerBase
    {
        [Authorize]
        [HttpGet("Config")]
        public ActionResult<TabConfig[]> GetTabConfigs()
        {
            return Ok(CustomTabsPlugin.Instance.Configuration.GetEnabledTabs());
        }

        [Authorize]
        [HttpGet("Order")]
        public ActionResult<string[]> GetTabOrder()
        {
            return Ok(CustomTabsPlugin.Instance.Configuration.TabOrder);
        }

        // Admin only: the raw image bytes are the request body.
        [Authorize(Policy = "RequiresElevation")]
        [HttpPost("Images")]
        [RequestSizeLimit(TabImageStore.MaxBytes)]
        public async Task<ActionResult> UploadImage()
        {
            using MemoryStream buffer = new MemoryStream();
            await Request.Body.CopyToAsync(buffer, HttpContext.RequestAborted).ConfigureAwait(false);

            if (buffer.Length == 0)
            {
                return BadRequest("The upload was empty.");
            }

            if (buffer.Length > TabImageStore.MaxBytes)
            {
                return StatusCode(StatusCodes.Status413PayloadTooLarge, "Images must be 2 MB or smaller.");
            }

            byte[] data = buffer.ToArray();
            string? extension = TabImageStore.DetectExtension(data);
            if (extension == null)
            {
                return BadRequest("Only PNG, JPEG, GIF, WebP, SVG and ICO images are supported.");
            }

            if (extension == "png" && !TabImageStore.IsCompletePng(data))
            {
                return BadRequest("This PNG file is incomplete or damaged, so only part of it would show. Try exporting or downloading it again.");
            }

            string fileName = TabImageStore.Save(data, extension);
            return Ok(new { Url = TabImageStore.UrlPrefix + fileName });
        }

        // Browsers fetch <img> sources without Jellyfin's auth header, so this
        // has to be anonymous. File names are random and unguessable.
        [AllowAnonymous]
        [HttpGet("Images/{fileName}")]
        public ActionResult GetImage([FromRoute] string fileName)
        {
            if (!TabImageStore.IsValidFileName(fileName))
            {
                return NotFound();
            }

            string path = Path.Combine(TabImageStore.Folder, fileName);
            if (!System.IO.File.Exists(path))
            {
                return NotFound();
            }

            Response.Headers["X-Content-Type-Options"] = "nosniff";
            // Inside <img> an SVG never runs scripts, but opening its URL
            // directly would. This policy blocks scripts and anything else
            // active while still allowing inline styles and gradients.
            Response.Headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";
            Response.Headers["Cache-Control"] = "public, max-age=31536000, immutable";
            return PhysicalFile(path, TabImageStore.GetContentType(fileName));
        }
    }
}
