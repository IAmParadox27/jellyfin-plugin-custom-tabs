// Scope everything in a check to avoid re-declaring the plugin
if (typeof window.customTabsPlugin == 'undefined') {

    // Define the plugin on the window object for universal access
    window.customTabsPlugin = {
        initialized: false,
        currentPage: null,
        renderedTabs: new WeakSet(),
        tabConfigs: {},
        configs: null,
        configPromise: null,
        tabOrder: [],
        headerIconOrder: [],
        hiddenTabs: [],
        hiddenDrawerTabs: [],
        tabOverrides: {},
        hiddenHeaderIcons: [],
        modernObserver: null,
        modernPending: false,
        modernMutating: false,

        // Tab configs are user content and must never be rendered for guests
        isAuthenticated: function() {
            if (typeof ApiClient === 'undefined') {
                return false;
            }

            if (typeof ApiClient.getCurrentUserId === 'function') {
                return !!ApiClient.getCurrentUserId();
            }

            return typeof ApiClient.accessToken === 'function' && !!ApiClient.accessToken();
        },

        // Kicks off the process
        init: function() {
            console.log('CustomTabs: Initializing plugin');

            if (typeof ApiClient === 'undefined') {
                setTimeout(() => this.init(), 200);
                return;
            }

            if (!this.isAuthenticated()) {
                console.debug('CustomTabs: No authenticated user, skipping');
                this.removeInjectedTabs();
                return;
            }

            // Jellyfin 12's Modern layout renders its own React header and hides the
            // legacy .skinHeader tab bar, so the legacy injection never becomes visible.
            if (this.isModernLayout()) {
                this.initModern();
                return;
            }

            // The legacy header is shared by every page, so the right-hand
            // buttons go in regardless of which page is showing.
            this.loadConfigs().then((configs) => {
                if (configs.length) {
                    this.ensureIconStyles();
                    this.ensureLegacyHeaderButtons(configs);
                }
            });

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
                return this.loadTabOrder();
            }).then(() => {
                return this.configs;
            }).catch((error) => {
                console.error('CustomTabs: Error fetching tab configs:', error);
                this.configPromise = null;
                return [];
            });

            return this.configPromise;
        },

        // The header order set on the settings page; missing on older servers
        loadTabOrder: function() {
            return ApiClient.fetch({
                url: ApiClient.getUrl('CustomTabs/Order'),
                type: 'GET',
                dataType: 'json',
                headers: {
                    accept: 'application/json'
                }
            }).then((order) => {
                // { Tabs, HeaderIcons }; casing depends on the server's JSON settings
                // A plain array is the tab order on its own
                order = Array.isArray(order) ? { Tabs: order } : (order || {});
                const tabs = order.Tabs || order.tabs;
                const icons = order.HeaderIcons || order.headerIcons;
                this.tabOrder = Array.isArray(tabs) ? tabs : [];
                this.headerIconOrder = Array.isArray(icons) ? icons : [];
                const hiddenTabs = order.HiddenTabs || order.hiddenTabs;
                const hiddenIcons = order.HiddenHeaderIcons || order.hiddenHeaderIcons;
                this.hiddenTabs = Array.isArray(hiddenTabs) ? hiddenTabs.map((k) => String(k).toLowerCase()) : [];
                this.hiddenHeaderIcons = Array.isArray(hiddenIcons) ? hiddenIcons.map((k) => String(k).toLowerCase()) : [];
                const hiddenDrawer = order.HiddenDrawerTabs || order.hiddenDrawerTabs;
                this.hiddenDrawerTabs = Array.isArray(hiddenDrawer) ? hiddenDrawer.map((k) => String(k).toLowerCase()) : [];
                const overrides = order.TabOverrides || order.tabOverrides;
                this.tabOverrides = {};
                (Array.isArray(overrides) ? overrides : []).forEach((o) => {
                    const key = String((o && (o.Key || o.key)) || '').toLowerCase();
                    if (key) {
                        this.tabOverrides[key] = {
                            Title: o.Title || o.title || '',
                            Icon: o.Icon || o.icon || '',
                            ImageUrl: o.ImageUrl || o.imageUrl || '',
                            HideTitle: !!(o.HideTitle || o.hideTitle),
                            HideIcon: !!(o.HideIcon || o.hideIcon)
                        };
                    }
                });
            }).catch(() => {
                this.tabOrder = [];
                this.headerIconOrder = [];
                this.hiddenTabs = [];
                this.hiddenDrawerTabs = [];
                this.hiddenHeaderIcons = [];
            });
        },

        // Drops every tab the plugin added, e.g. after the user logs out
        removeInjectedTabs: function() {
            document.querySelectorAll('[id^="customTabButton_"], [id^="customTabDrawerButton_"], [id^="customTabHeaderButton_"]')
                .forEach((element) => element.remove());

            document.querySelectorAll('[id^="customTab_"]')
                .forEach((element) => element.remove());

            const main = document.querySelector('main');
            if (main) {
                main.classList.remove('customTabActive');
            }

            this.tabConfigs = {};
            this.renderedTabs = new WeakSet();
        },

        // Waits for the necessary page elements to be ready before acting
        waitForUI: function() {
            if (!this.isAuthenticated()) {
                console.debug('CustomTabs: No authenticated user, skipping UI check');
                return;
            }

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

            if (!this.isAuthenticated()) {
                console.debug('CustomTabs: No authenticated user, skipping tab creation');
                return;
            }

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

                this.ensureIconStyles();

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
                    const showText = this.fillTabLabel(title, config);

                    const button = document.createElement("button");
                    button.type = "button";
                    button.setAttribute("is", "empty-button");
                    button.classList.add("emby-tab-button", "emby-button");
                    button.setAttribute("data-index", i + 2);
                    button.setAttribute("id", customTabId);
                    if (!showText) {
                        button.setAttribute("aria-label", config.Title);
                        button.setAttribute("title", config.Title);
                    }
                    button.appendChild(title);

                    // emby-tabs maps buttons to panels by position, so a tab
                    // shown on the right still needs its (hidden) button here.
                    if (this.isRightPlacement(config)) {
                        button.style.display = 'none';
                    }

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

        // --- Tab icons and images ---------------------------------------------

        // Icons used by default for tabs with these names (built-in or
        // custom) when no icon or image has been set for them. Each is an
        // alpha mask, drawn in the text colour so it matches the other tabs.
        defaultTabIcons: {
            'anime': 'data:image/png;base64,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'
        },

        defaultTabIconFor: function(label) {
            const key = this.normaliseLabel(label);
            return Object.prototype.hasOwnProperty.call(this.defaultTabIcons, key) ? this.defaultTabIcons[key] : null;
        },

        buildDefaultIcon: function(label) {
            const mask = this.defaultTabIconFor(label);
            if (!mask) {
                return null;
            }
            const span = document.createElement('span');
            span.className = 'customTabIcon customTabMaskIcon';
            span.setAttribute('aria-hidden', 'true');
            span.style.setProperty('--ct-mask', `url("${mask}")`);
            return span;
        },

        // Returns the element for a tab's image or Material icon, or null when
        // the tab has neither. An image wins when both are configured. A tab
        // with neither falls back to its default icon, if its name has one.
        buildTabIcon: function(config) {
            const imageUrl = (config.ImageUrl || '').trim();
            if (imageUrl) {
                const img = document.createElement('img');
                // Uploaded images are stored as a server path, which has to go
                // through getUrl so it works when Jellyfin has a base URL.
                img.src = imageUrl.indexOf('CustomTabs/Images/') === 0 && typeof ApiClient !== 'undefined'
                    ? ApiClient.getUrl(imageUrl)
                    : imageUrl;
                img.alt = '';
                img.className = 'customTabIcon customTabImage';
                img.setAttribute('aria-hidden', 'true');
                return img;
            }

            // Jellyfin's Material icon font maps "material-icons <name>" to a
            // glyph, so only allow characters that appear in icon names.
            const iconName = (config.Icon || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
            if (iconName) {
                const span = document.createElement('span');
                span.className = `material-icons customTabIcon ${iconName}`;
                span.setAttribute('aria-hidden', 'true');
                return span;
            }

            return config.Title ? this.buildDefaultIcon(config.Title) : null;
        },

        // Text is only hidden when there is an icon or image to show instead
        shouldShowText: function(config, icon) {
            return !config.HideTitle || !icon || !config.Title;
        },

        // Fills a legacy tab's label and reports whether the text is shown
        fillTabLabel: function(container, config) {
            const icon = this.buildTabIcon(config);
            const showText = this.shouldShowText(config, icon);

            if (icon) {
                container.appendChild(icon);
            }

            if (showText) {
                const label = document.createElement('span');
                label.className = 'customTabLabel';
                label.textContent = config.Title;
                container.appendChild(label);
            }

            return showText;
        },

        ensureIconStyles: function() {
            if (document.getElementById('customTabsIconStyles')) {
                return;
            }

            const style = document.createElement('style');
            style.id = 'customTabsIconStyles';
            style.textContent = '.customTabIcon{vertical-align:middle;}'
                + '.customTabImage{height:1.5em;width:auto;max-width:6em;object-fit:contain;display:inline-block;}'
                + '.emby-button-foreground > .customTabIcon + .customTabLabel{margin-left:.4em;vertical-align:middle;}'
                + '.customTabHeaderButton .customTabImage{height:24px;max-width:48px;display:block;}'
                + '.customTabHeaderButton .customTabLabel{font-size:.875rem;white-space:nowrap;}'
                + '.customTabHeaderButton[aria-current="page"]{background-color:rgba(255,255,255,.12);}'
                + '.customTabsHidden{display:none !important;}'
                + '.customTabsIconOnly{margin-left:0 !important;margin-right:0 !important;}'
                + '.customTabsOverrideIcon.material-icons{font-size:20px;}'
                // Default icons are masks filled with the text colour
                + '.customTabMaskIcon{display:inline-block;width:1.4em;height:1.4em;background-color:currentColor;vertical-align:middle;'
                + '-webkit-mask:var(--ct-mask) center/contain no-repeat;mask:var(--ct-mask) center/contain no-repeat;}'
                + '.MuiButton-startIcon>.customTabMaskIcon,.MuiListItemIcon-root>.customTabMaskIcon,.customTabHeaderButton>.customTabMaskIcon{width:22px;height:22px;}'
                // On narrow screens the header icons scroll sideways instead of
                // running off the edge. The group is right-aligned with an auto
                // margin rather than justify-content, so that when it overflows
                // the first icons can still be scrolled to.
                + '@media (max-width:1100px){'
                + '.customTabsIconGroup{overflow-x:auto;overflow-y:hidden;min-width:0;flex-shrink:1;flex-wrap:nowrap;'
                + 'justify-content:flex-start !important;scrollbar-width:none;-webkit-overflow-scrolling:touch;'
                + 'overscroll-behavior-x:contain;padding-top:4px;padding-bottom:4px;}'
                + '.customTabsIconGroup::-webkit-scrollbar{display:none;}'
                + '.customTabsIconGroup>*{flex-shrink:0;}'
                + '.customTabsIconGroup>:first-child{margin-left:auto;}'
                + '.customTabsPinnedRight{flex-shrink:0;}'
                + '}';
            document.head.appendChild(style);
        },

        // --- Right-hand header buttons -----------------------------------------
        // A tab with Placement "Right" gets a button among the header's icons
        // (search, cast, user and so on) instead of a tab in the left bar.

        isRightPlacement: function(config) {
            return (config.Placement || '').toLowerCase() === 'right';
        },

        // Icon or image only; the title becomes the tooltip. With neither set,
        // the title is shown as text so the button is never empty.
        fillHeaderButton: function(button, config) {
            const icon = this.buildTabIcon(config);
            if (icon) {
                button.appendChild(icon);
            } else {
                const label = document.createElement('span');
                label.className = 'customTabLabel';
                label.textContent = config.Title;
                button.appendChild(label);
            }

            button.classList.add('customTabHeaderButton');
            button.setAttribute('title', config.Title);
            button.setAttribute('aria-label', config.Title);
        },

        openTab: function(index) {
            // On the legacy home page, the tab bar handles switching panels
            const legacyTab = document.getElementById(`customTabButton_${index}`);
            if (legacyTab && legacyTab.classList.contains('emby-tab-button')) {
                legacyTab.click();
                return;
            }

            window.location.hash = `#/home?tab=${index + 2}`;
        },

        ensureLegacyHeaderButtons: function(configs) {
            const headerRight = document.querySelector('.skinHeader .headerRight');
            if (!headerRight) {
                return;
            }

            configs.forEach((config, i) => {
                const id = `customTabHeaderButton_${i}`;
                if (!this.isRightPlacement(config) || document.getElementById(id)) {
                    return;
                }

                const button = document.createElement('button');
                button.type = 'button';
                button.id = id;
                button.setAttribute('is', 'paper-icon-button-light');
                button.className = 'headerButton headerButtonRight paper-icon-button-light';
                this.fillHeaderButton(button, config);
                button.addEventListener('click', () => this.openTab(i));
                headerRight.appendChild(button);
                console.log(`CustomTabs: Added ${id} to the header`);
            });

            headerRight.classList.add('customTabsIconGroup');
            this.pinUserMenu(headerRight, headerRight.parentElement || headerRight);
            const items = Array.from(headerRight.children).filter((el) => !this.isUserMenuControl(el));
            this.recordHeaderIcons(items);
            this.arrangeHeaderIcons(headerRight, items);
        },

        // --- Right-hand header order --------------------------------------
        // Native buttons are matched on their accessible label. The settings
        // page cannot know which buttons a header has (Jellyfin's own and
        // other plugins'), so the labels seen here are kept in this browser's
        // storage, where the settings page (same origin) can list them.

        headerIconsStorageKey: 'customTabs.headerIcons',

        // Every name a header icon can be matched on, best first: aria-label,
        // title, a stable id, then the Material icon it shows. Plugins often
        // add icons with only an id or an icon-font glyph, and some redraw
        // their buttons with a different attribute set (e.g. the tooltip
        // moving between title and aria-label), so matching tries them all.
        nativeButtonNames: function(el) {
            const names = [];
            const add = (value) => {
                const name = (value || '').trim();
                if (name && names.indexOf(name) === -1) {
                    names.push(name);
                }
            };

            const nodes = [el].concat(Array.from(el.querySelectorAll('[aria-label], [title], [id]')));
            nodes.forEach((node) => add(node.getAttribute('aria-label')));
            nodes.forEach((node) => add(node.getAttribute('title')));
            // React and MUI generate ids like ":r3:" that change between loads
            nodes.forEach((node) => {
                if (node.id && node.id.indexOf(':') === -1 && !this.isOurHeaderButton(node)) {
                    add(node.id);
                }
            });

            const glyph = el.querySelector('.material-icons, .material-icons-outlined, .material-symbols-outlined, .material-symbols-rounded');
            if (glyph) {
                add(glyph.textContent);
                add(Array.from(glyph.classList).find((c) => c.indexOf('material-') !== 0));
            }

            return names;
        },

        // The name shown on the settings page
        nativeButtonLabel: function(el) {
            return this.nativeButtonNames(el)[0] || '';
        },

        isOurHeaderButton: function(el) {
            return (el.id || '').indexOf('customTabHeaderButton_') === 0;
        },

        // The custom header button an item is or wraps, if any
        ourHeaderButtonIn: function(item) {
            return this.isOurHeaderButton(item) ? item : item.querySelector('[id^="customTabHeaderButton_"]');
        },

        // All keys an item can match in the saved order, best first
        headerIconKeys: function(item) {
            const ours = this.ourHeaderButtonIn(item);
            if (ours) {
                const config = this.configs && this.configs[parseInt(ours.id.replace(/\D+/g, ''), 10)];
                return config && config.Id ? [`custom:${config.Id}`.toLowerCase()] : [];
            }

            return this.nativeButtonNames(item).map((name) => `stock:${this.normaliseLabel(name)}`);
        },

        headerIconRank: function(item, rank) {
            const keys = this.headerIconKeys(item);
            for (let i = 0; i < keys.length; i++) {
                if (rank.has(keys[i])) {
                    return rank.get(keys[i]);
                }
            }
            return undefined;
        },

        recordHeaderIcons: function(items) {
            const labels = [];
            items.forEach((item) => {
                // Skip ours and icons hidden by their plugin (e.g. SyncPlay when
                // unavailable), but keep ones switched off here, so they stay
                // on the settings page and can be switched back on
                if (this.ourHeaderButtonIn(item)
                    || (!item.getClientRects().length && !item.classList.contains('customTabsHidden'))) {
                    return; // ours, or hidden (e.g. SyncPlay when unavailable)
                }
                const label = this.nativeButtonLabel(item);
                if (label && labels.indexOf(label) === -1) {
                    labels.push(label);
                }
            });

            if (!labels.length) {
                return;
            }

            try {
                const json = JSON.stringify(labels);
                if (window.localStorage.getItem(this.headerIconsStorageKey) !== json) {
                    window.localStorage.setItem(this.headerIconsStorageKey, json);
                }
            } catch (e) {
                // Storage unavailable (private mode); the settings page then
                // only lists custom header buttons
            }
        },

        // Orders the items (in DOM order) inside container, moving any that
        // live elsewhere (e.g. in another plugin's wrapper) into it. Without a
        // saved order, custom buttons sit in front of the native
        // ones. With one, listed items follow it; custom buttons it does not
        // mention go first and unnamed native ones (e.g. some avatars) last.
        arrangeHeaderIcons: function(container, items) {
            if (!items.length) {
                return;
            }

            // Jellyfin's (and other plugins') icons switched off on the
            // settings page; matched on any of their names
            const hiddenIcons = this.hiddenHeaderIcons || [];
            items.forEach((item) => {
                if (this.ourHeaderButtonIn(item)) {
                    return;
                }
                const hide = hiddenIcons.length > 0
                    && this.headerIconKeys(item).some((key) => hiddenIcons.indexOf(key) !== -1);
                item.classList.toggle('customTabsHidden', hide);
            });

            // Icons inside the tab bar never belong there: Jellyfin Enhanced
            // puts its tray at the start of it, before the logo, because it
            // takes the tab bar for the header's action area. Unless the saved
            // order places them, they move in front of Jellyfin's icons.
            const bar = this.getModernBar();
            const misplaced = (item) => !!bar && bar.contains(item) && !this.ourHeaderButtonIn(item);

            // No saved order: leave every other native icon where it is
            // (other plugins' included) and keep ours, then any misplaced
            // icons, just in front of the first native icon in the container
            if (!this.headerIconOrder || !this.headerIconOrder.length) {
                const moving = items.filter((item) => this.ourHeaderButtonIn(item))
                    .concat(items.filter(misplaced));
                if (!moving.length) {
                    return;
                }
                const anchor = items.find((item) => !this.ourHeaderButtonIn(item) && !misplaced(item)
                    && item.parentElement === container) || null;
                const together = moving.every((el, i) => el.parentElement === container
                    && el.nextElementSibling === (i + 1 < moving.length ? moving[i + 1] : anchor));
                if (!together) {
                    moving.forEach((el) => container.insertBefore(el, anchor));
                }
                return;
            }

            // With a saved order, only the icons it lists are moved (gathered
            // into the container in that order), plus custom buttons it does
            // not mention, which go just in front of them. Icons it does not
            // list (e.g. ones another plugin added after the order was saved)
            // are left exactly where their plugin put them.
            const rank = new Map(this.headerIconOrder.map((key, i) => [String(key).toLowerCase(), i]));
            const ranked = [];
            const unrankedOurs = [];
            const unrankedMisplaced = [];
            items.forEach((item, position) => {
                const r = this.headerIconRank(item, rank);
                if (r !== undefined) {
                    ranked.push({ item, r, position });
                } else if (this.ourHeaderButtonIn(item)) {
                    unrankedOurs.push(item);
                } else if (misplaced(item)) {
                    unrankedMisplaced.push(item);
                }
            });

            ranked.sort((a, b) => a.r - b.r || a.position - b.position);
            const desired = unrankedOurs.concat(unrankedMisplaced, ranked.map((entry) => entry.item));
            if (!desired.length) {
                return;
            }

            const inContainer = Array.from(container.children).filter((child) => desired.indexOf(child) !== -1);
            const inPlace = inContainer.length === desired.length
                && inContainer.every((child, i) => child === desired[i]);
            if (inPlace) {
                return;
            }

            // Re-insert them as one run where the first of them inside the
            // container is now (or the first native icon there)
            const marker = document.createComment('customTabs');
            const anchor = inContainer[0]
                || items.find((item) => item.parentElement === container && !this.ourHeaderButtonIn(item))
                || null;
            container.insertBefore(marker, anchor);
            desired.forEach((item) => container.insertBefore(item, marker));
            marker.remove();
            console.debug('CustomTabs: Reordered the header icons');
        },

        // Run customTabsPlugin.debugHeader() in the browser console to see
        // what the plugin makes of the header: each right-hand icon, the
        // names it can be matched on, and its place in the saved order.
        debugHeader: function() {
            const rank = new Map((this.headerIconOrder || []).map((key, i) => [String(key).toLowerCase(), i]));
            const group = this.getModernHeaderRightGroup();
            const legacy = document.querySelector('.skinHeader .headerRight');
            const items = group ? group.items : (legacy ? Array.from(legacy.children) : []);
            const describe = (el) => el ? `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''}` : '(none)';
            const rows = items.map((item, i) => {
                const r = this.headerIconRank(item, rank);
                return {
                    position: i + 1,
                    names: this.headerIconKeys(item).join(', ') || '(no name)',
                    savedPlace: r === undefined ? '(not in saved order)' : r + 1,
                    element: describe(item),
                    parent: describe(item.parentElement),
                    visible: item.getClientRects().length > 0
                };
            });

            const toolbar = document.querySelector('header.MuiAppBar-root .MuiToolbar-root');
            const toolbarChildren = toolbar ? Array.from(toolbar.children).map((child) => describe(child)
                + ' [' + Array.from(child.querySelectorAll('button, a[href]')).map((c) => this.nativeButtonLabel(c) || '?').join(', ') + ']') : [];
            const tabBar = this.getModernBar();
            const tabBarChildren = tabBar ? Array.from(tabBar.children).map((child) => describe(child)
                + ' [' + (this.nativeButtonLabel(child) || child.textContent.trim().slice(0, 30)) + ']') : [];
            const drawerLists = this.getModernDrawerLists().map((ul, i) => `list ${i + 1}: `
                + Array.from(ul.children).map((child) => describe(child) + ' [' + child.textContent.trim().slice(0, 30)
                    + (child.querySelector('.MuiListItemIcon-root') ? ', has icon slot' : '') + ']').join(' | '));
            console.log('CustomTabs header debug', {
                drawerLists: drawerLists.length ? drawerLists : '(side menu not open or not rendered)',
                toolbarChildren: toolbarChildren,
                tabBarChildren: tabBarChildren,
                layout: group ? 'modern' : (legacy ? 'legacy' : 'not found'),
                tabBarFound: !!this.getModernBar(),
                savedHeaderIconOrder: this.headerIconOrder,
                recorded: (() => { try { return JSON.parse(localStorage.getItem(this.headerIconsStorageKey) || '[]'); } catch (e) { return 'unavailable'; } })()
            });
            console.table(rows);
            return rows;
        },

        // The clickable elements on the right of the modern header (after the
        // tab links, or after the menu button when the links are collapsed
        // into the drawer), whatever they are: MUI IconButtons, plain buttons
        // or links added by other plugins. Returns the closest container
        // holding all of them, and for each one the child of that container
        // it sits in, which is what gets moved.
        getModernHeaderRightGroup: function() {
            if (document.body.classList.contains('dashboardDocument')) return null;
            const toolbar = document.querySelector('header.MuiAppBar-root .MuiToolbar-root');
            if (!toolbar) {
                return null;
            }

            // Search the whole app bar: a plugin can put its icons next to the
            // toolbar rather than inside it
            const root = toolbar.closest('header.MuiAppBar-root') || toolbar;
            const selector = 'button, a[href], [role="button"]';
            const allControls = Array.from(root.querySelectorAll(selector))
                .filter((el) => !(el.parentElement && el.parentElement.closest(selector)));
            let controls = allControls;

            // Every control in the toolbar is a header icon except the menu
            // button, the back button (shown on pages other than home), the
            // server logo / home link and the tab links. This goes by what a
            // control is, not where it sits: other plugins put their icons in
            // different places (Jellyfin Enhanced can put its tray right after
            // the menu button), and only icons listed in the saved order are
            // ever moved.
            const bar = this.getModernBar();
            const beforeBar = (el) => bar && (bar.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING);
            // Inside the tab bar only links are tabs; a plugin's icon buttons
            // can end up in there too (Jellyfin Enhanced's tray can)
            const isLeftControl = (el) => this.isHeaderMenuButton(el) || this.isHeaderBackButton(el)
                || this.isUserMenuControl(el)
                || this.isHomeLink(el) || (bar && bar.contains(el) && !this.isIconControl(el))
                || (beforeBar(el) && this.isHeaderLogo(el));
            controls = allControls.filter((el) => !isLeftControl(el));

            if (!controls.length) {
                return null;
            }

            // Each icon's item is the outermost wrapper holding only that icon
            // (e.g. a tooltip span), so icons that a plugin groups in its own
            // wrapper can still be ordered one by one. Counting every control
            // in the toolbar keeps a wrapper that also holds the menu button
            // or logo from being moved.
            const controlCount = (el) => allControls.filter((c) => el.contains(c)).length;
            const items = controls.map((el) => {
                let item = el;
                while (item.parentElement && item.parentElement !== toolbar && item.parentElement !== root
                    && item.parentElement !== bar && controlCount(item.parentElement) === 1) {
                    item = item.parentElement;
                }
                return item;
            });

            return { toolbar, controls, items };
        },

        ensureModernHeaderButtons: function() {
            const wanted = this.configs
                .map((config, i) => ({ config, i }))
                .filter((entry) => this.isRightPlacement(entry.config));

            let group = this.getModernHeaderRightGroup();
            if (!group) {
                return;
            }

            // Style source: a native MUI icon button with an icon, else any
            // native control with one
            // Prefer icons right of the tab bar, so an unrecognised control on
            // the left (or a plugin's tray) never becomes the insert point
            const bar = this.getModernBar();
            const allNatives = group.controls.filter((el) => !this.isOurHeaderButton(el));
            const rightNatives = bar
                ? allNatives.filter((el) => !bar.contains(el) && (bar.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))
                : allNatives;
            const pick = (natives) => natives.find((el) => el.classList.contains('MuiIconButton-root') && el.querySelector('svg'))
                || natives.find((el) => el.querySelector('svg, .material-icons'))
                || natives[0];
            const template = pick(rightNatives) || pick(allNatives);

            if (!template) {
                return;
            }

            // Everything is gathered in the container of the native icon used
            // as the template, normally Jellyfin's own icon group
            const templateItem = group.items.find((item) => item.contains(template));
            const container = templateItem.parentElement;
            // Lets the icon row scroll on narrow screens (see ensureIconStyles).
            // Never the toolbar itself, which would scroll the menu button too.
            const toolbar = document.querySelector('header.MuiAppBar-root .MuiToolbar-root');
            if (container !== toolbar && !container.matches('header') && !container.classList.contains('customTabsIconGroup')) {
                container.classList.add('customTabsIconGroup');
            }

            let added = false;
            wanted.forEach(({ config, i }) => {
                const id = `customTabHeaderButton_${i}`;
                if (document.getElementById(id)) {
                    return;
                }

                const button = template.cloneNode(false);
                button.id = id;
                button.removeAttribute('aria-describedby');
                button.removeAttribute('aria-haspopup');
                button.removeAttribute('aria-controls');
                button.removeAttribute('aria-expanded');
                button.removeAttribute('aria-label');
                button.removeAttribute('title');
                if (button.tagName === 'A') {
                    button.setAttribute('href', `#/home?tab=${i + 2}`);
                } else {
                    button.addEventListener('click', () => this.openTab(i));
                }
                this.fillHeaderButton(button, config);
                container.insertBefore(button, templateItem);
                added = true;
                console.log(`CustomTabs: Added ${id} to the modern header`);
            });

            if (added) {
                group = this.getModernHeaderRightGroup() || group;
            }

            // Runs even with no custom header buttons, so Jellyfin's own icons
            // can be reordered and listed on the settings page
            this.recordHeaderIcons(group.items);
            this.arrangeHeaderIcons(container, group.items);
            this.pinUserMenu(container, toolbar.closest('header') || toolbar);
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
            if (document.body.classList.contains('dashboardDocument')) return null;
            // The stack holding the tab links; the icon group on the right can
            // be a stack too, so require a tab link (text button or home tab)
            const stacks = Array.from(document.querySelectorAll('header.MuiAppBar-root .MuiToolbar-root .MuiStack-root'));
            return stacks.find((stack) => stack.querySelector('a.MuiButton-root, a[href^="#/home?tab="]')) || null;
        },

        // Below roughly 768px the header links unmount and MUI renders a drawer
        getModernDrawerList: function() {
            if (document.body.classList.contains('dashboardDocument')) return null;
            return document.querySelector('.MuiDrawer-paper ul.MuiList-root');
        },

        // Every list in the drawer: Jellyfin keeps the libraries in their own
        // list (under a "Media" heading), apart from Home and Favorites
        getModernDrawerLists: function() {
            if (document.body.classList.contains('dashboardDocument')) return [];
            return Array.from(document.querySelectorAll('.MuiDrawer-paper ul.MuiList-root'));
        },

        // The React header itself, so pages that show it without tab links
        // (e.g. with a back button) are still recognised
        isModernLayout: function() {
            if (document.body.classList.contains('dashboardDocument')) return false;
            return !!document.querySelector('header.MuiAppBar-root .MuiToolbar-root')
                || !!this.getModernBar() || !!this.getModernDrawerList();
        },

        initModern: function() {
            if (typeof ApiClient === 'undefined') {
                console.debug('CustomTabs: Waiting for ApiClient on modern layout...');
                setTimeout(() => this.initModern(), 200);
                return;
            }

            if (!this.isAuthenticated()) {
                console.debug('CustomTabs: No authenticated user, skipping modern tabs');
                this.removeInjectedTabs();
                return;
            }

            this.loadConfigs().then((configs) => {
                if (!configs.length) {
                    console.debug('CustomTabs: No tabs configured, nothing to add');
                    return;
                }

                this.ensureModernStyles();
                this.ensureIconStyles();
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

        stopModernObserver: function() {
            if (!this.modernObserver) {
                return;
            }

            this.modernObserver.disconnect();
            this.modernObserver = null;
            console.debug('CustomTabs: Stopped watching for React re-renders');
        },

        syncModern: function() {
            if (!this.isAuthenticated()) {
                this.stopModernObserver();
                this.removeInjectedTabs();
                return;
            }

            if (!this.configs || !this.configs.length) {
                return;
            }

            this.modernMutating = true;
            try {
                this.ensureModernTabs();
                this.ensureModernHeaderButtons();
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
                    if (this.isRightPlacement(config) || bar.querySelector(`[id="${id}"]`)) {
                        return;
                    }

                    const template = Array.from(bar.children).find((el) => el.tagName === 'A'
                        && (el.getAttribute('href') || '').indexOf('#/home?tab=') === 0);

                    if (!template) {
                        return;
                    }

                    bar.appendChild(this.cloneModernTab(template, config, i, id));
                    console.log(`CustomTabs: Added ${id} to the modern header`);
                });

                this.arrangeTabs(bar, '[id^="customTabButton_"]');
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
                    });

                    if (!template) {
                        return;
                    }

                    const item = template.cloneNode(true);
                    const link = item.querySelector('a');
                    if (!link) {
                        return;
                    }

                    link.id = id;
                    this.decorateModernTab(link, config, i, true);
                    list.appendChild(item);
                    console.log(`CustomTabs: Added ${id} to the modern drawer`);
                });

                this.arrangeTabs(list, '[id^="customTabDrawerButton_"]');
            }

            // The other drawer lists hold more of Jellyfin's own tabs (the
            // libraries): give them their renames, icons and hiding too
            this.getModernDrawerLists().forEach((other) => {
                if (other !== list) {
                    this.applyStockChanges(other);
                }
            });
        },

        // Renames, icon changes and hiding for the built-in items of a list
        // that holds no custom tabs, without reordering it
        applyStockChanges: function(container) {
            const hidden = this.hiddenDrawerTabs || [];
            const isDrawer = container.tagName === 'UL' || container.classList.contains('MuiList-root');
            Array.from(container.children).forEach((el) => {
                // Only navigation items: skip headings, dividers and nested lists
                if (!el.querySelector('a[href], [role="button"]') && !(el.tagName === 'A' && el.getAttribute('href'))) {
                    return;
                }
                if (el.querySelector('ul.MuiList-root')) {
                    return;
                }
                const key = `stock:${this.stockLabel(el)}`;
                this.applyStockOverride(el, isDrawer);
                el.classList.toggle('customTabsHidden', hidden.indexOf(key) !== -1);
            });
        },

        normaliseLabel: function(text) {
            return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
        },

        // "custom:<id>" for our tabs, "stock:<label>" for Jellyfin's own
        tabKey: function(el, selector) {
            const ours = el.matches(selector) ? el : el.querySelector(selector);
            if (ours) {
                const config = this.configs && this.configs[parseInt(ours.id.replace(/\D+/g, ''), 10)];
                return config && config.Id ? `custom:${config.Id}`.toLowerCase() : null;
            }

            return `stock:${this.stockLabel(el)}`;
        },

        // A built-in tab's original label, remembered the first time it is
        // seen, so a renamed tab keeps its key for ordering and hiding
        stockLabel: function(el) {
            if (el.dataset.ctLabel === undefined) {
                el.dataset.ctLabel = this.normaliseLabel(el.textContent);
            }
            return el.dataset.ctLabel;
        },

        // Applies the settings page's changes to one of Jellyfin's own tabs:
        // a new label, hidden text, a hidden or replaced icon. Idempotent, and
        // undoes itself when the change is removed. The drawer keeps its text.
        applyStockOverride: function(el, isDrawer) {
            const key = `stock:${this.stockLabel(el)}`;
            const o = (this.tabOverrides && this.tabOverrides[key]) || null;
            const link = el.tagName === 'A' ? el : (el.querySelector('a') || el);

            // Text: the header button keeps its label in a trailing text node,
            // the drawer item in MuiListItemText
            let textTarget = link.__ctTextTarget;
            if (!textTarget || !link.contains(textTarget)) {
                textTarget = isDrawer
                    ? link.querySelector('.MuiListItemText-root span, .MuiListItemText-primary, .MuiTypography-root')
                    : Array.from(link.childNodes).reverse()
                        .find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim() !== '');
                if (textTarget) {
                    link.__ctTextTarget = textTarget;
                    link.__ctOriginalText = textTarget.textContent;
                }
            }

            const original = link.__ctOriginalText || '';
            const label = (o && o.Title) ? o.Title : original.trim();
            const hideText = !!(o && o.HideTitle) && !isDrawer;
            if (textTarget) {
                const wanted = hideText ? '' : ((o && o.Title) ? o.Title : original);
                if (textTarget.textContent !== wanted) {
                    textTarget.textContent = wanted;
                }
            }

            if (hideText) {
                if (link.getAttribute('title') !== label) {
                    link.setAttribute('title', label);
                    link.setAttribute('aria-label', label);
                    link.dataset.ctTitled = '1';
                }
            } else if (link.dataset.ctTitled) {
                link.removeAttribute('title');
                link.removeAttribute('aria-label');
                delete link.dataset.ctTitled;
            }

            // Icon
            const hideIcon = !!(o && o.HideIcon);
            const replacement = (o && (o.ImageUrl || o.Icon)) ? { ImageUrl: o.ImageUrl, Icon: o.Icon } : null;
            // Without a chosen icon, a tab whose (new) name has a default icon
            // uses that instead of Jellyfin's
            const shownName = this.normaliseLabel(label);
            const useDefault = !replacement && !!this.defaultTabIconFor(shownName);
            const signature = replacement ? `${replacement.ImageUrl}|${replacement.Icon}` : (useDefault ? `default:${shownName}` : '');
            let slot = link.querySelector('.MuiButton-startIcon, .MuiListItemIcon-root');
            let ours = link.querySelector('.customTabsOverrideIcon');

            if ((replacement || useDefault) && !hideIcon) {
                if (!ours || ours.dataset.ctSig !== signature) {
                    const icon = replacement ? this.buildTabIcon(replacement) : this.buildDefaultIcon(shownName);
                    if (icon) {
                        icon.classList.add('customTabsOverrideIcon');
                        icon.dataset.ctSig = signature;
                        if (!slot) {
                            slot = document.createElement(isDrawer ? 'div' : 'span');
                            slot.className = isDrawer ? 'MuiListItemIcon-root customTabsAddedSlot' : 'MuiButton-startIcon customTabsAddedSlot';
                            link.insertBefore(slot, link.firstChild);
                        }
                        if (ours) {
                            ours.replaceWith(icon);
                        } else {
                            slot.appendChild(icon);
                        }
                        ours = icon;
                    }
                }
            } else if (ours) {
                ours.remove();
                ours = null;
            }

            if (slot) {
                // Jellyfin's own icon hides when replaced or hidden
                Array.from(slot.children).forEach((child) => {
                    if (!child.classList.contains('customTabsOverrideIcon')) {
                        child.classList.toggle('customTabsHidden', hideIcon || !!ours);
                    }
                });
                slot.classList.toggle('customTabsHidden', hideIcon);
                slot.classList.toggle('customTabsIconOnly', hideText);
            }
        },

        // The drawer (hamburger) button. MUI marks it edge="start"; the label
        // check covers builds without that, but deliberately not "User menu"
        isHeaderMenuButton: function(el) {
            if (el.classList.contains('MuiIconButton-edgeStart') || el.querySelector('svg[data-testid="MenuIcon"]')) {
                return true;
            }
            const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
            return /^(open |toggle |show )?(the )?(main |navigation )?(menu|navigation|drawer|sidebar)$/i.test(label);
        },

        // The user menu (profile picture) stays pinned at the right end of
        // the header, outside the icon row, like the menu button on the left
        isUserMenuControl: function(el) {
            if (el.classList.contains('headerUserButton') || el.querySelector('.MuiAvatar-root')) {
                return true;
            }
            const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
            return /^(user menu|account|my account|profile|user profile)$/i.test(label);
        },

        // Keeps the user menu just after the icon row, so it doesn't scroll
        // away with the other icons on narrow screens
        pinUserMenu: function(container, root) {
            const controls = Array.from(root.querySelectorAll('button, a[href], [role="button"]'));
            const userMenu = controls.find((el) => this.isUserMenuControl(el));
            if (!userMenu || !container.contains(userMenu)) {
                return;
            }

            // Move the outermost wrapper inside the row that holds only it
            let item = userMenu;
            while (item.parentElement && item.parentElement !== container) {
                item = item.parentElement;
            }
            if (item.parentElement !== container) {
                return;
            }

            item.classList.add('customTabsPinnedRight');
            container.after(item);
        },

        // An icon button rather than a tab link: tab links (and the logo) are
        // text links, while header icons are buttons or icon-button links
        isIconControl: function(el) {
            if (el.id && (el.id.indexOf('customTabButton_') === 0 || el.id.indexOf('customTabDrawerButton_') === 0)) {
                return false;
            }
            return el.tagName === 'BUTTON'
                || el.matches('.MuiIconButton-root, .headerButton, [role="button"]');
        },

        // The back button the modern header shows on pages other than home
        isHeaderBackButton: function(el) {
            if (el.querySelector('svg[data-testid="ArrowBackIcon"], svg[data-testid="ArrowBackIosIcon"], svg[data-testid="ArrowBackIosNewIcon"]')) {
                return true;
            }
            const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
            return /^(go )?back$/i.test(label);
        },

        isHomeLink: function(el) {
            const link = el.tagName === 'A' ? el : el.querySelector('a');
            const href = (link && link.getAttribute('href')) || '';
            return /^#\/home(\.html)?\/?$/.test(href);
        },

        // The server logo / home link: a link to the home page with no tab
        // selected, or one showing an image
        isHeaderLogo: function(el) {
            const link = el.tagName === 'A' ? el : el.querySelector('a');
            const href = (link && link.getAttribute('href')) || '';
            return /^#\/home(\.html)?\/?$/.test(href) || !!el.querySelector('img');
        },

        // Orders built-in and custom tabs together by the numbered list on
        // the settings page. Anything unlisted at the very start of the bar,
        // such as the server logo / home link next to the menu button, stays
        // locked there; other tabs it does not mention (e.g. a library added
        // since) go after the listed ones. React does not
        // re-sort nodes that only moved, and the observer re-applies this
        // after any re-render.
        arrangeTabs: function(container, selector) {
            const isOurs = (el) => el.matches(selector) || !!el.querySelector(selector);
            const children = Array.from(container.children);

            // Tabs switched off or changed on the settings page. The header
            // and the side menu (drawer) each have their own hidden list; in
            // the drawer it covers custom tabs too.
            const isDrawer = container.tagName === 'UL' || container.classList.contains('MuiList-root');
            const hidden = (isDrawer ? this.hiddenDrawerTabs : this.hiddenTabs) || [];
            children.forEach((el) => {
                if (isOurs(el)) {
                    if (isDrawer) {
                        const customKey = this.tabKey(el, selector);
                        el.classList.toggle('customTabsHidden', !!customKey && hidden.indexOf(customKey) !== -1);
                    }
                    return;
                }
                const key = this.tabKey(el, selector);
                this.applyStockOverride(el, isDrawer);
                el.classList.toggle('customTabsHidden', !!key && hidden.indexOf(key) !== -1);
            });

            if (!children.some(isOurs)) {
                return;
            }

            if (!this.tabOrder || !this.tabOrder.length) {
                this.keepLast(container, selector);
                return;
            }

            const rank = new Map(this.tabOrder.map((key, i) => [String(key).toLowerCase(), i]));
            const locked = [];
            const ranked = [];
            const unrankedNative = [];
            const unrankedOurs = [];
            children.forEach((el, position) => {
                const key = this.tabKey(el, selector);
                const r = key ? rank.get(key) : undefined;
                if (r === undefined && !isOurs(el) && (locked.length === position || this.isHeaderLogo(el))) {
                    locked.push(el);
                } else if (r !== undefined) {
                    ranked.push({ el, r, position });
                } else if (isOurs(el)) {
                    unrankedOurs.push(el);
                } else {
                    unrankedNative.push(el);
                }
            });

            ranked.sort((a, b) => a.r - b.r || a.position - b.position);
            const desired = locked.concat(ranked.map((entry) => entry.el), unrankedNative, unrankedOurs);
            if (desired.every((el, i) => children[i] === el)) {
                return;
            }

            desired.forEach((el, i) => {
                const current = container.children[i];
                if (current !== el) {
                    container.insertBefore(el, current);
                }
            });
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

        // The drawer is a labelled list with room to spare, so it always keeps
        // the text; HideTitle only applies to the header bar.
        decorateModernTab: function(link, config, index, isDrawer) {
            link.setAttribute('href', `#/home?tab=${index + 2}`);
            link.removeAttribute('aria-current');

            const icon = this.buildTabIcon(config);
            const showText = isDrawer || this.shouldShowText(config, icon);
            this.setModernLabel(link, showText ? config.Title : '');

            // Drop the cloned tab's own icon, but reuse MUI's icon slot for
            // ours so it picks up the native spacing and sizing.
            link.querySelectorAll('svg').forEach((svg) => svg.remove());
            const slot = link.querySelector('.MuiButton-startIcon, .MuiListItemIcon-root');

            if (icon && slot) {
                slot.replaceChildren(icon);
                if (!showText) {
                    slot.style.margin = '0';
                }
            } else {
                if (slot) {
                    slot.remove();
                }
                if (icon) {
                    link.insertBefore(icon, link.firstChild);
                }
            }

            if (!showText) {
                link.setAttribute('aria-label', config.Title);
                link.setAttribute('title', config.Title);
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
            document.querySelectorAll('[id^="customTabButton_"], [id^="customTabDrawerButton_"], [id^="customTabHeaderButton_"]').forEach((link) => {
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
                let tabDiv = document.getElementById(tabContentId);
                if (!tabDiv) {
                    tabDiv = this.ensureContentDiv(tabContentId);
                    if (!tabDiv) return;
                }

                // Navigation can replace a panel while reusing its ID.
                if (this.renderedTabs.has(tabDiv)) return;

                const config = this.tabConfigs[tabContentId];
                this.setInnerHTMLWithScripts(tabDiv, config.ContentHtml || '');
                this.renderedTabs.add(tabDiv);
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
