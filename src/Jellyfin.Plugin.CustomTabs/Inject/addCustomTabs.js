// Scope everything in a check to avoid re-declaring the plugin
if (typeof window.customTabsPlugin == 'undefined') {

    // Define the plugin on the window object for universal access
    window.customTabsPlugin = {
        initialized: false,
        currentPage: null,
        renderedTabs: new Set(),
        tabConfigs: {},
        configs: null,
        configPromise: null,
        modernObserver: null,
        modernPending: false,
        modernMutating: false,

        // Kicks off the process
        init: function() {
            console.log('CustomTabs: Initializing plugin');

            // Jellyfin 12's Modern layout renders its own React header and hides the
            // legacy .skinHeader tab bar, so the legacy injection never becomes visible.
            if (this.isModernLayout()) {
                this.initModern();
                return;
            }

            this.waitForUI();
        },

        // Fetch the tab configuration once and share it between both layouts
        loadConfigs: function() {
            if (this.configPromise) {
                return this.configPromise;
            }

            this.configPromise = ApiClient.fetch({
                url: ApiClient.getUrl('CustomTabs/Config'),
                type: 'GET',
                dataType: 'json',
                headers: {
                    accept: 'application/json'
                }
            }).then((configs) => {
                this.configs = configs || [];
                return this.configs;
            }).catch((error) => {
                console.error('CustomTabs: Error fetching tab configs:', error);
                this.configPromise = null;
                return [];
            });

            return this.configPromise;
        },

        // Waits for the necessary page elements to be ready before acting
        waitForUI: function() {
            // Check if we are on the home page by looking at the URL hash
            const hash = window.location.hash;
            if (hash !== '' && hash !== '#/home' && hash !== '#/home.html' && !hash.includes('#/home?') && !hash.includes('#/home.html?')) {
                console.debug('CustomTabs: Not on main page, skipping UI check. Hash:', hash);
                return;
            }

            // If the UI is ready, create tabs; otherwise, wait and check again
            if (typeof ApiClient !== 'undefined' && document.querySelector('.emby-tabs-slider')) {
                console.debug('CustomTabs: UI elements available on main page, creating tabs');
                this.createCustomTabs();
            } else {
                console.debug('CustomTabs: Waiting for UI elements on main page...');
                setTimeout(() => this.waitForUI(), 200);
            }
        },

        // Fetches config and creates the tab elements in the DOM
        createCustomTabs: function() {
            console.debug('CustomTabs: Starting tab creation process');

            const tabsSlider = document.querySelector('.emby-tabs-slider');
            if (!tabsSlider) {
                console.debug('CustomTabs: Tabs slider not found');
                return;
            }

            // Prevent creating duplicate tabs if they already exist
            if (tabsSlider.querySelector('[id^="customTabButton_"]')) {
                console.debug('CustomTabs: Custom tabs already exist in DOM, skipping creation');
                this.renderTabContent();
                return;
            }

            // Fetch tab configuration from the server
            ApiClient.fetch({
                url: ApiClient.getUrl('CustomTabs/Config'),
                type: 'GET',
                dataType: 'json',
                headers: {
                    accept: 'application/json'
                }
            }).then((configs) => {
                console.debug('CustomTabs: Retrieved config for', configs.length, 'tabs');

                const tabsSlider = document.querySelector('.emby-tabs-slider');
                if (!tabsSlider) {
                    console.error('CustomTabs: Tabs slider disappeared unexpectedly');
                    return;
                }

                // Loop through configs and create a tab for each one
                configs.forEach((config, i) => {
                    const customTabId = `customTabButton_${i}`;
                    const customTabContentId = `customTab_${i}`;

                    // Final check to ensure this specific tab doesn't already exist
                    if (document.querySelector(`#${customTabId}`)) {
                        console.debug(`CustomTabs: Tab ${customTabId} already exists, skipping`);
                        return; // 'return' here acts like 'continue' in a forEach loop
                    }

                    console.log("CustomTabs: Creating custom tab:", config.Title);

                    const title = document.createElement("div");
                    title.classList.add("emby-button-foreground");
                    title.innerText = config.Title;

                    const button = document.createElement("button");
                    button.type = "button";
                    button.setAttribute("is", "empty-button");
                    button.classList.add("emby-tab-button", "emby-button");
                    button.setAttribute("data-index", i + 2);
                    button.setAttribute("id", customTabId);
                    button.appendChild(title);

                    tabsSlider.appendChild(button);
                    console.log(`CustomTabs: Added tab ${customTabId} to tabs slider`);

                    this.tabConfigs[customTabContentId] = config;
                });

                this.renderTabContent();

                console.log('CustomTabs: All custom tabs created successfully');
            }).catch((error) => {
                console.error('CustomTabs: Error fetching tab configs:', error);
            });
        },

        // --- Jellyfin 12 Modern layout ---------------------------------------
        // The Modern layout builds its header with React and MUI. The legacy
        // .skinHeader still exists but its container is display:none, so tabs
        // injected there are never visible. These helpers add the tab to the
        // React header instead, and render its content into <main>.

        // Emotion generates the class hashes (css-x5lcu9 and friends) at build
        // time, so they change whenever jellyfin-web is rebuilt. Match on the
        // stable MUI component classes only, and clone a live sibling for the
        // rest of the styling.
        getModernBar: function() {
            return document.querySelector('header.MuiAppBar-root .MuiToolbar-root .MuiStack-root');
        },

        // Below roughly 768px the header links unmount and MUI renders a drawer
        getModernDrawerList: function() {
            return document.querySelector('.MuiDrawer-paper ul.MuiList-root');
        },

        isModernLayout: function() {
            return !!this.getModernBar() || !!this.getModernDrawerList();
        },

        initModern: function() {
            if (typeof ApiClient === 'undefined') {
                console.debug('CustomTabs: Waiting for ApiClient on modern layout...');
                setTimeout(() => this.initModern(), 200);
                return;
            }

            this.loadConfigs().then((configs) => {
                if (!configs.length) {
                    console.debug('CustomTabs: No tabs configured, nothing to add');
                    return;
                }

                this.ensureModernStyles();
                this.syncModern();
                this.startModernObserver();
            });
        },

        // React re-renders the header on navigation and discards anything we
        // appended, so watch for it and put the tab back.
        startModernObserver: function() {
            if (this.modernObserver) {
                return;
            }

            this.modernObserver = new MutationObserver(() => {
                if (this.modernMutating) {
                    return;
                }
                this.scheduleModernSync();
            });

            this.modernObserver.observe(document.body, { childList: true, subtree: true });
            console.debug('CustomTabs: Watching for React re-renders');
        },

        scheduleModernSync: function() {
            if (this.modernPending) {
                return;
            }

            this.modernPending = true;
            requestAnimationFrame(() => {
                this.modernPending = false;
                this.syncModern();
            });
        },

        syncModern: function() {
            if (!this.configs || !this.configs.length) {
                return;
            }

            this.modernMutating = true;
            try {
                this.ensureModernTabs();
                this.renderModernContent();
            } finally {
                this.modernMutating = false;
            }
        },

        ensureModernStyles: function() {
            if (document.getElementById('customTabsModernStyles')) {
                return;
            }

            const style = document.createElement('style');
            style.id = 'customTabsModernStyles';
            style.textContent = '[id^="customTabButton_"][aria-current="page"]{background-color:rgba(255,255,255,.12);}'
                + '[id^="customTab_"]{min-height:calc(100vh - 48px);}'
                + 'main.customTabActive > *:not([id^="customTab_"]){display:none !important;}';
            document.head.appendChild(style);
        },

        ensureModernTabs: function() {
            const bar = this.getModernBar();
            if (bar) {
                this.configs.forEach((config, i) => {
                    const id = `customTabButton_${i}`;
                    if (bar.querySelector(`[id="${id}"]`)) {
                        return;
                    }

                    const template = Array.from(bar.children).find((el) => el.tagName === 'A'
                        && (el.getAttribute('href') || '').indexOf('#/home?tab=') === 0)
                        || Array.from(bar.children).find((el) => el.tagName === 'A');

                    if (!template) {
                        return;
                    }

                    bar.appendChild(this.cloneModernTab(template, config, i, id));
                    console.log(`CustomTabs: Added ${id} to the modern header`);
                });

                this.keepLast(bar, '[id^="customTabButton_"]');
            }

            const list = this.getModernDrawerList();
            if (list) {
                this.configs.forEach((config, i) => {
                    const id = `customTabDrawerButton_${i}`;
                    if (list.querySelector(`[id="${id}"]`)) {
                        return;
                    }

                    const items = Array.from(list.children).filter((el) => el.tagName === 'LI');
                    const template = items.find((el) => {
                        const link = el.querySelector('a');
                        return link && (link.getAttribute('href') || '').indexOf('#/home?tab=') === 0;
                    }) || items[items.length - 1];

                    if (!template) {
                        return;
                    }

                    const item = template.cloneNode(true);
                    const link = item.querySelector('a');
                    if (!link) {
                        return;
                    }

                    link.id = id;
                    this.decorateModernTab(link, config, i);
                    list.appendChild(item);
                    console.log(`CustomTabs: Added ${id} to the modern drawer`);
                });

                this.keepLast(list, '[id^="customTabDrawerButton_"]');
            }
        },

        // React reconciles its own children back in around anything we append,
        // which leaves our tab sitting in the middle of the native links. Put
        // it back at the end whenever that happens.
        keepLast: function(container, selector) {
            const ours = Array.from(container.children)
                .filter((el) => el.matches(selector) || el.querySelector(selector));

            if (!ours.length) {
                return;
            }

            const tail = Array.from(container.children).slice(-ours.length);
            if (ours.some((el, i) => tail[i] !== el)) {
                ours.forEach((el) => container.appendChild(el));
            }
        },

        cloneModernTab: function(template, config, index, id) {
            const tab = template.cloneNode(true);
            tab.id = id;
            this.decorateModernTab(tab, config, index);
            return tab;
        },

        decorateModernTab: function(link, config, index) {
            link.setAttribute('href', `#/home?tab=${index + 2}`);
            link.removeAttribute('aria-current');
            this.setModernLabel(link, config.Title);

            const path = link.querySelector('svg path');
            if (path) {
                path.setAttribute('d', 'M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2m0 16H3V5h10v4h8z');
                const svg = link.querySelector('svg');
                if (svg) {
                    svg.removeAttribute('data-testid');
                }
            }
        },

        // The header button keeps its label in a trailing text node; the drawer
        // item keeps it inside MuiListItemText.
        setModernLabel: function(link, title) {
            const textNode = Array.from(link.childNodes).reverse()
                .find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== '');

            if (textNode) {
                textNode.textContent = title;
                return;
            }

            const span = link.querySelector('.MuiListItemText-root span, .MuiListItemText-primary, .MuiTypography-root');
            if (span) {
                span.textContent = title;
                return;
            }

            link.appendChild(document.createTextNode(title));
        },

        // Tab 0 is Home and tab 1 is Favourites, so custom tabs start at 2.
        // React renders nothing for those, which leaves <main> free for us.
        getModernTabIndex: function() {
            const match = /#\/home(?:\.html)?\?(?:.*&)?tab=(\d+)/.exec(window.location.hash);
            if (!match) {
                return null;
            }

            const index = parseInt(match[1], 10) - 2;
            return (index >= 0 && this.configs && index < this.configs.length) ? index : null;
        },

        renderModernContent: function() {
            const main = document.querySelector('main');
            if (!main) {
                return;
            }

            const index = this.getModernTabIndex();
            const existing = main.querySelector('[id^="customTab_"]');

            if (index === null) {
                if (existing) {
                    existing.remove();
                }
                main.classList.remove('customTabActive');
                this.setModernSelected(null);
                return;
            }

            // React still renders the home rows underneath, so hide everything
            // in <main> that is not ours while a custom tab is open.
            main.classList.add('customTabActive');

            const wantedId = `customTab_${index}`;
            if (existing && existing.id === wantedId) {
                this.setModernSelected(index);
                return;
            }

            if (existing) {
                existing.remove();
            }

            const content = document.createElement('div');
            content.id = wantedId;
            content.setAttribute('data-index', index + 2);
            this.setInnerHTMLWithScripts(content, this.configs[index].ContentHtml || '');
            main.appendChild(content);
            this.setModernSelected(index);
            console.debug(`CustomTabs: Rendered ${wantedId} into main`);
        },

        setModernSelected: function(index) {
            document.querySelectorAll('[id^="customTabButton_"], [id^="customTabDrawerButton_"]').forEach((link) => {
                const own = parseInt(link.id.replace(/\D+/g, ''), 10);
                if (index !== null && own === index) {
                    link.setAttribute('aria-current', 'page');
                } else {
                    link.removeAttribute('aria-current');
                }
            });
        },

        // Render content into tab divs, properly executing <script> tags
        renderTabContent: function() {
            if (!this.tabConfigs) return;

            Object.keys(this.tabConfigs).forEach((tabContentId) => {
                if (this.renderedTabs.has(tabContentId)) return;

                let tabDiv = document.getElementById(tabContentId);
                if (!tabDiv) {
                    tabDiv = this.ensureContentDiv(tabContentId);
                    if (!tabDiv) return;
                }

                const config = this.tabConfigs[tabContentId];
                this.setInnerHTMLWithScripts(tabDiv, config.ContentHtml || '');
                this.renderedTabs.add(tabContentId);
                console.debug(`CustomTabs: Rendered content for ${tabContentId}`);
            });
        },

        // If the serve-time-injected content div is missing (e.g. browser
        // cached an old home-html chunk), create it on the fly.
        ensureContentDiv: function(tabContentId) {
            const index = parseInt(tabContentId.replace('customTab_', ''), 10);
            const contentDiv = document.createElement('div');
            contentDiv.id = tabContentId;
            contentDiv.setAttribute('data-index', index + 2);

            const anchor = document.getElementById('favoritesTab');
            if (anchor && anchor.parentNode) {
                anchor.parentNode.insertBefore(contentDiv, anchor.nextSibling);
                console.debug(`CustomTabs: Created missing content div ${tabContentId} after favoritesTab`);
                return contentDiv;
            }

            const slider = document.querySelector('.emby-tabs-slider');
            const page = slider ? slider.closest('.page') : null;
            if (page) {
                page.appendChild(contentDiv);
                console.debug(`CustomTabs: Created missing content div ${tabContentId} (fallback to page)`);
                return contentDiv;
            }
            return null;
        },

        // Set innerHTML but properly execute <script> tags
        setInnerHTMLWithScripts: function(element, html) {
            element.innerHTML = html;

            const scripts = element.querySelectorAll('script');
            scripts.forEach((oldScript) => {
                const newScript = document.createElement('script');

                for (let i = 0; i < oldScript.attributes.length; i++) {
                    const attr = oldScript.attributes[i];
                    newScript.setAttribute(attr.name, attr.value);
                }

                if (oldScript.textContent) {
                    newScript.textContent = oldScript.textContent;
                }

                oldScript.parentNode.replaceChild(newScript, oldScript);
            });
        }
    };

    // --- Event Listeners to Handle Navigation ---

    // Initial setup when the page is first loaded
    if (document.readyState === 'loading') {
        document.addEventListener("DOMContentLoaded", () => window.customTabsPlugin.init());
    } else {
        window.customTabsPlugin.init();
    }

    // A single handler for all navigation-style events
    const handleNavigation = () => {
        console.debug('CustomTabs: Navigation detected, re-initializing after delay');
        // Delay helps ensure the DOM has settled after navigation
        setTimeout(() => {
            window.customTabsPlugin.init();
        }, 800);
    };

    // Standard browser navigation (back/forward buttons)
    window.addEventListener("popstate", handleNavigation);

    // The modern layout routes through the hash, so react to it immediately
    // rather than waiting for the delayed handler above.
    window.addEventListener("hashchange", () => {
        if (window.customTabsPlugin.isModernLayout()) {
            window.customTabsPlugin.syncModern();
        }
    });

    // Mobile-specific events that can signify a page change
    window.addEventListener("pageshow", handleNavigation);
    window.addEventListener("focus", handleNavigation);

    // Monkey-patch history API to detect navigation
    const originalPushState = history.pushState;
    history.pushState = function() {
        originalPushState.apply(history, arguments);
        handleNavigation();
    };

    const originalReplaceState = history.replaceState;
    history.replaceState = function() {
        originalReplaceState.apply(history, arguments);
        handleNavigation();
    };

    // Handle tab visibility changes (e.g., user switches to another tab and back)
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
            console.debug('CustomTabs: Page became visible, checking for tabs');
            setTimeout(() => window.customTabsPlugin.init(), 300);
        }
    });

    // Handle touch events which can also trigger navigation on mobile
    let touchNavigation = false;
    document.addEventListener("touchstart", () => {
        touchNavigation = true;
    });

    document.addEventListener("touchend", () => {
        if (touchNavigation) {
            setTimeout(() => window.customTabsPlugin.init(), 1000);
            touchNavigation = false;
        }
    });

    console.log('CustomTabs: Plugin setup complete');
}
