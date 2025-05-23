﻿console.log('Injecting custom tabs');
if (typeof customTabsPlugin == 'undefined') {
    const customTabsPlugin = {
        initialized: false,
        init: function () {
            var MutationObserver    = window.MutationObserver || window.WebKitMutationObserver;
            var myObserver          = new MutationObserver (this.mutationHandler);
            var obsConfig           = { childList: true, characterData: true, attributes: true, subtree: true };

            $("body").each ( function () {
                myObserver.observe (this, obsConfig);
            } );
        },
        mutationHandler: function (mutationRecords) {
            // get the text of the current page or undefined
            const currentPage = $('.pageTitle')[0]?.innerHTML

            if (customTabsPlugin.initialized && customTabsPlugin.page === currentPage) {
              return;
            }

            // If the page didn't match, set our intialized flag to false.
            customTabsPlugin.initialized = false;

            // We're not on the main page
            // Config for this could enumerate a list of target pages.
            if (currentPage !== "") return;

            // Okay, we're back on the main page let's do this thing.
            mutationRecords.forEach ( function (mutation) {
                console.log (mutation.type);
                if (mutation.addedNodes && mutation.addedNodes.length > 0) {

                    [].some.call(mutation.addedNodes, function (addedNode) {
                        if ($('.emby-tabs-slider').length > 0) {
                            customTabsPlugin.initialized = true;
                            // store current page title when we succeeded
                            customTabsPlugin.page = currentPage
                            customTabsPlugin.createCustomTabs();
                        }
                    });
                }
            } );
        },
        createCustomTabs: function () {
            if (this.initialized === true) {
                // TODO: Request tab configs from server.

                ApiClient.fetch({
                    url: ApiClient.getUrl('CustomTabs/Config'),
                    type: 'GET',
                    dataType: 'json',
                    headers: {
                        accept: 'application/json'
                    }
                }).then(function (configs) {
                    for (var i = 0; i < configs.length; i++) {
                        var config = configs[i];
                        
                        console.log("Creating custom tab");
                        const title = document.createElement("div");
                        title.classList.add("emby-button-foreground");
                        title.innerText = config.Title;

                        const button = document.createElement("button");
                        button.type = "button";
                        button.is = "empty-button";
                        button.classList.add("emby-tab-button", "emby-button", "lastFocused");
                        button.setAttribute("data-index", i + 2);
                        button.setAttribute("id", "customTabButton_" + i);
                        button.appendChild(title);

                        (function e() {
                            const tabb = document.querySelector(".emby-tabs-slider");
                            if (tabb && !document.querySelector("#customTabButton_" + i)) {
                                tabb.appendChild(button);
                            } else if (!tabb) {
                                setTimeout(e, 500);
                            }
                        })();
                    }
                });
                
            }
        }
    }
    
    // Initial page load
    document.addEventListener("DOMContentLoaded", () => {
        customTabsPlugin.init();
    });
    
    // When navigating back or forward
    window.addEventListener("popstate", () => {
        customTabsPlugin.init();
    });
}
