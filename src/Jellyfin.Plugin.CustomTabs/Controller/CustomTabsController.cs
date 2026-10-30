using Jellyfin.Plugin.CustomTabs.Configuration;
using Microsoft.AspNetCore.Authorization;
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
            return Ok(CustomTabsPlugin.Instance.Configuration.Tabs);
        }
    }
}
