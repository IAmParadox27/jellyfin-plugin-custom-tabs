// Scope everything in a check to avoid re-declaring the plugin
if (typeof window.customTabsPlugin == 'undefined') {

    // Define the plugin on the window object for universal access.
    //
    // jellyfin-web resolves a Home tab by *position*, not by data-index: emby-tabs
    // selects tabButtons[N] and maintabsmanager activates the N-th .tabContent of
    // the Home view. Custom tab i lives at index i + 2 (after Home and Favorites),
    // so its button and panel have to sit at position i + 2 as well.
    //
    // Everything below is a reconcile pass: it looks at the page that is actually
    // shown, fixes whatever does not match the configured tabs, and does nothing
    // when the page is already right. It runs on every relevant change, so it
    // also repairs what Jellyfin rebuilds behind our back (a re-created Home view,
    // a rebuilt tab strip, a cached Home page from an earlier visit).
    window.customTabsPlugin = {
        // Rendered HTML per panel element. Keyed by element, not ID: Jellyfin
        // re-creates panels with the same ID when it rebuilds the Home view.
        renderedTabs: new WeakMap(),
        configs: null,
        configPromise: null,
        configSignature: null,
        // Home visits so far (a navigation into Home from anywhere else), the
        // visit the tab list was last re-read for, and when.
        homeVisits: 0,
        onHome: false,
        refreshedFor: 0,
        lastFetch: 0,
        layout: null,
        observer: null,
        syncPending: false,
        watchedTabs: null,
        // The ctTab link last applied, or overridden by the user's own pick:
        // { hash, tabs, byUser }. Jellyfin can rebuild the tab strip with the
        // link's stale number after we applied it, so a new tab strip applies
        // it again.
        appliedLink: null,
        // The stale number a ctTab link was corrected from (Jellyfin may still
        // select it a moment later, from the URL it routed with).
        correctedFrom: null,
        selectingTab: false,
        lastTabStripInput: 0,

        // Kicks off the process. Safe to call any number of times.
        init: function() {
            this.startObserver();
            this.scheduleSync();
        },

        isHomeHash: function() {
            const hash = window.location.hash;
            return hash === '' || hash === '#/home' || hash === '#/home.html' || hash.includes('#/home?') || hash.includes('#/home.html?');
        },

        // Fetch the tab configuration, shared by both layouts. A fresh request
        // is made by refreshConfigs(); until it answers the last list is used.
        loadConfigs: function() {
            if (this.configPromise) {
                return this.configPromise;
            }
            return this.refreshConfigs();
        },

        refreshConfigs: function() {
            this.lastFetch = Date.now();
            const request = ApiClient.fetch({
                url: ApiClient.getUrl('CustomTabs/Config'),
                type: 'GET',
                dataType: 'json',
                headers: {
                    accept: 'application/json'
                }
            }).then((configs) => {
                this.applyConfigs(Array.isArray(configs) ? configs : []);
                return this.configs;
            }).catch((error) => {
                console.error('CustomTabs: Error fetching tab configs:', error);
                if (this.configPromise === request) {
                    this.configPromise = this.configs ? Promise.resolve(this.configs) : null;
                }
                return this.configs || [];
            });

            if (!this.configs) {
                this.configPromise = request;
            }
            return request;
        },

        // Store a fresh tab list. When it differs from the one on screen, every
        // tab of ours is rebuilt on the next sync.
        applyConfigs: function(configs) {
            const signature = JSON.stringify(configs.map((config) => [config.Id, config.Title, config.ContentHtml]));
            this.configPromise = Promise.resolve(configs);
            if (signature === this.configSignature) {
                return;
            }

            const hadConfigs = this.configs !== null;
            this.configs = configs;
            this.configSignature = signature;
            if (hadConfigs) {
                console.log('CustomTabs: Tab configuration changed, updating tabs');
                this.removeModernTabs();
            }
            this.scheduleSync();
        },

        // --- Scheduling ------------------------------------------------------

        // React and Jellyfin's view manager re-render the header and the Home
        // view on navigation and discard anything we added, so watch the page
        // and reconcile once per frame after any change.
        startObserver: function() {
            if (this.observer || !document.body) {
                return;
            }

            this.observer = new MutationObserver(() => this.scheduleSync());
            this.observer.observe(document.body, { childList: true, subtree: true });
        },

        scheduleSync: function() {
            if (this.syncPending) {
                return;
            }

            this.syncPending = true;
            requestAnimationFrame(() => {
                this.syncPending = false;
                this.sync();
            });
        },

        sync: function() {
            if (typeof ApiClient === 'undefined') {
                return;
            }

            // Jellyfin may restore a cached Home view, so count visits by
            // navigation rather than by view element.
            const onHome = this.isHomeHash();
            if (onHome && !this.onHome) {
                this.homeVisits++;
            }
            if (!onHome) {
                this.appliedLink = null;
                this.correctedFrom = null;
            }
            this.onHome = onHome;

            // Changing the layout reloads the app, so it is detected once.
            if (!this.layout) {
                this.layout = this.detectLayout();
                if (!this.layout) {
                    return;
                }
            }

            if (!this.configs) {
                this.loadConfigs();
                return;
            }

            try {
                if (this.layout === 'modern') {
                    // The Modern header (and its links) is shown on every page.
                    this.syncModern();
                } else if (this.isHomeHash()) {
                    this.syncLegacy();
                }
            } finally {
                // Our own changes must not schedule another pass.
                this.observer?.takeRecords();
            }
        },

        // The Modern layout renders a React header and hides the legacy one;
        // Jellyfin still builds the hidden legacy tab strip there. Decide from
        // what is actually shown, and keep waiting while neither has rendered
        // (at startup React may not have mounted yet).
        detectLayout: function() {
            if (this.isModernLayout()) {
                return 'modern';
            }
            const slider = document.querySelector('.emby-tabs-slider');
            if (slider && this.isShown(slider)) {
                return 'legacy';
            }
            return null;
        },

        // Rendered (not display:none itself or through an ancestor). Works for
        // fixed-position elements such as Jellyfin's header, unlike offsetParent.
        isShown: function(el) {
            return el.getClientRects().length > 0;
        },

        // Re-read the tab list once per Home visit, so tabs the admin added,
        // removed or edited show up without a reload.
        refreshOnVisit: function() {
            if (this.refreshedFor === this.homeVisits) {
                return;
            }
            this.refreshedFor = this.homeVisits;
            if (Date.now() - this.lastFetch > 1500) {
                this.refreshConfigs();
            }
        },

        // --- Links -----------------------------------------------------------
        // A tab's link is #/home?tab=N&ctTab=<id>. N is what Jellyfin selects;
        // the id keeps a saved link on the same tab when tabs are added,
        // removed or reordered (N is the tab's position + 2). A link whose N no
        // longer matches its id is corrected in place before it is used.

        hashParam: function(name) {
            const match = new RegExp('[?&]' + name + '=([^&]*)').exec(window.location.hash);
            if (!match) {
                return null;
            }
            try {
                return decodeURIComponent(match[1]);
            } catch (e) {
                return match[1];
            }
        },

        tabLink: function(index) {
            const id = this.configs[index] && this.configs[index].Id;
            return `#/home?tab=${index + 2}` + (id ? `&ctTab=${encodeURIComponent(id)}` : '');
        },

        // The custom tab the URL asks for: { index, id } (index null when a
        // ctTab link names a tab that no longer exists; such a link is pointed
        // at Home, tab=0), or null when the URL names no custom tab.
        resolveLinkedTab: function() {
            if (!this.isHomeHash() || !this.configs) {
                return null;
            }

            const id = this.hashParam('ctTab');
            const tab = parseInt(this.hashParam('tab'), 10);
            if (id !== null) {
                const index = this.configs.findIndex((config) => config.Id === id);
                const wanted = index === -1 ? 0 : index + 2;
                if (tab !== wanted) {
                    this.correctedFrom = isNaN(tab) ? null : tab;
                    const route = window.location.hash.split('?')[0];
                    const hash = `${route}?tab=${wanted}&ctTab=${encodeURIComponent(id)}`;
                    // A tab the user picked since stays picked; a link we applied
                    // with the old number is applied again with the new one.
                    if (this.appliedLink && this.appliedLink.byUser && this.appliedLink.hash === window.location.hash) {
                        this.appliedLink.hash = hash;
                    } else {
                        this.appliedLink = null;
                    }
                    history.replaceState(history.state, '', window.location.pathname + window.location.search + hash);
                }
                return { index: index === -1 ? null : index, id: id };
            }

            if (!isNaN(tab) && tab >= 2 && tab - 2 < this.configs.length) {
                return { index: tab - 2, id: null };
            }
            return null;
        },

        // --- Legacy layout (10.11, and 12.x with a legacy layout) ------------

        // The Home view currently shown. Jellyfin keeps earlier views in the DOM
        // (hidden) and can hold two Home views at once, e.g. #/home and
        // #/home?tab=2, whose panels share IDs, so every lookup is scoped here.
        getActiveHomeView: function() {
            const views = Array.from(document.querySelectorAll('.tabContent.pageTabContent[data-index="0"]'))
                .map((homeTab) => homeTab.parentElement)
                .filter((view) => view && !view.classList.contains('hide') && !view.hidden);
            if (views.length === 1) {
                // The common case: the only Home view not hidden by Jellyfin.
                // No need to ask the browser for layout on every pass.
                return views[0];
            }
            for (let i = views.length - 1; i >= 0; i--) {
                if (this.isShown(views[i])) {
                    return views[i];
                }
            }
            return null;
        },

        syncLegacy: function() {
            const slider = document.querySelector('.emby-tabs-slider');
            const view = this.getActiveHomeView();
            if (!slider || !view) {
                return;
            }

            this.refreshOnVisit();

            const tabsElem = slider.closest('[is="emby-tabs"]');
            this.watchTabs(tabsElem);

            const buttonsChanged = this.ensureLegacyButtons(slider);
            this.ensureLegacyPanels(view);
            this.applyLinkedTab(tabsElem);
            this.reconcileSelection(tabsElem, view);

            // The tab strip caches each button's position when it is built and
            // does not watch for new children.
            if (buttonsChanged) {
                tabsElem?.refresh?.();
            }
        },

        // Create, update and remove our buttons, and keep them right after
        // Favorites in index order (Jellyfin selects buttons by position).
        ensureLegacyButtons: function(slider) {
            let changed = false;
            const configs = this.configs;

            slider.querySelectorAll('[id^="customTabButton_"]').forEach((button) => {
                const i = parseInt(button.id.replace('customTabButton_', ''), 10);
                if (!(i < configs.length)) {
                    button.remove();
                    changed = true;
                }
            });

            configs.forEach((config, i) => {
                const id = `customTabButton_${i}`;
                let button = slider.querySelector(`[id="${id}"]`);
                if (!button) {
                    button = document.createElement('button');
                    button.type = 'button';
                    button.setAttribute('is', 'empty-button');
                    button.classList.add('emby-tab-button', 'emby-button');
                    button.id = id;
                    const title = document.createElement('div');
                    title.classList.add('emby-button-foreground');
                    button.appendChild(title);
                    slider.appendChild(button);
                    changed = true;
                    console.log(`CustomTabs: Added tab ${id} to tabs slider`);
                }
                if (button.getAttribute('data-index') !== String(i + 2)) {
                    button.setAttribute('data-index', String(i + 2));
                }
                const title = button.querySelector('.emby-button-foreground');
                if (title && title.textContent !== config.Title) {
                    title.textContent = config.Title;
                }
            });

            if (this.placeAfterFavorites(slider, '.emby-tab-button', (el) => el.id.indexOf('customTabButton_') === 0)) {
                changed = true;
            }
            return changed;
        },

        // Make sure each tab has its panel in the shown Home view, filled with
        // its current content. The server normally injects empty panels into the
        // Home template; when that did not happen (a theme reformatted the
        // template, a cached template from before a tab was added) they are
        // created here, with the classes Jellyfin needs to show and hide them.
        ensureLegacyPanels: function(view) {
            const configs = this.configs;

            view.querySelectorAll('[id^="customTab_"]').forEach((panel) => {
                const i = parseInt(panel.id.replace('customTab_', ''), 10);
                if (panel.parentElement === view && !(i < configs.length)) {
                    panel.remove();
                }
            });

            configs.forEach((config, i) => {
                const id = `customTab_${i}`;
                let panel = view.querySelector(`:scope > [id="${id}"]`);
                if (!panel) {
                    panel = document.createElement('div');
                    panel.id = id;
                    view.appendChild(panel);
                    console.debug(`CustomTabs: Created missing panel ${id}`);
                }
                panel.classList.add('tabContent', 'pageTabContent');
                if (panel.getAttribute('data-index') !== String(i + 2)) {
                    panel.setAttribute('data-index', String(i + 2));
                }

                const html = config.ContentHtml || '';
                if (this.renderedTabs.get(panel) !== html) {
                    this.setInnerHTMLWithScripts(panel, html);
                    this.renderedTabs.set(panel, html);
                    console.debug(`CustomTabs: Rendered content for ${id}`);
                }
            });

            this.placeAfterFavorites(view, '.tabContent', (el) => el.id.indexOf('customTab_') === 0);
        },

        // Move our elements (direct children of `container` matching `selector`)
        // into index order right after the index-1 element. Only out-of-place
        // elements move. Returns whether anything moved.
        placeAfterFavorites: function(container, selector, isOurs) {
            const items = Array.from(container.children).filter((el) => el.matches(selector));
            const favorites = items.find((el) => el.getAttribute('data-index') === '1');
            if (!favorites) {
                return false;
            }

            const ours = items.filter(isOurs).sort((a, b) =>
                parseInt(a.getAttribute('data-index'), 10) - parseInt(b.getAttribute('data-index'), 10));
            let changed = false;
            let ref = favorites;
            ours.forEach((el) => {
                if (ref.nextElementSibling !== el) {
                    container.insertBefore(el, ref.nextElementSibling);
                    changed = true;
                }
                ref = el;
            });
            return changed;
        },

        // Keep exactly one tab selected: its button highlighted and its panel
        // shown. Jellyfin only deactivates the previously highlighted tab, so a
        // selection it could not finish (a ?tab=N link opened before our button
        // existed, a tab strip rebuilt after Back) leaves a custom panel showing
        // under another tab, or a tab shown with no button highlighted.
        reconcileSelection: function(tabsElem, view) {
            if (!tabsElem || typeof tabsElem.selectedIndex !== 'function') {
                return;
            }

            // The same lists, in the same order, that Jellyfin indexes into.
            const buttons = Array.from(tabsElem.querySelectorAll('.emby-tab-button'));
            const panels = Array.from(view.querySelectorAll('.tabContent'));
            const highlighted = buttons.filter((el) => el.classList.contains('emby-tab-button-active'));
            if (highlighted.length > 1) {
                return;
            }

            // Jellyfin records the selection before it finishes applying it, and
            // records a click only 120 ms after showing it. Trust the highlighted
            // tab when its panel is shown (a click in progress), otherwise the
            // recorded index when its panel is shown (an unfinished deep link).
            const recorded = tabsElem.selectedIndex();
            const shown = highlighted.length ? buttons.indexOf(highlighted[0]) : -1;
            let selected = recorded;
            if (shown !== -1 && shown !== recorded) {
                if (panels[shown] && panels[shown].classList.contains('is-active')) {
                    selected = shown;
                } else if (!(panels[recorded] && panels[recorded].classList.contains('is-active'))) {
                    selected = shown;
                }
            }

            const button = buttons[selected];
            const panel = panels[selected];
            if (!button || !panel
                || button.getAttribute('data-index') !== String(selected)
                || panel.getAttribute('data-index') !== String(selected)) {
                // The tab strip and panels do not line up (yet); leave them alone.
                return;
            }

            const isOurs = button.id.indexOf('customTabButton_') === 0 && panel.id.indexOf('customTab_') === 0;
            const strayPanels = panels.filter((el) => el !== panel && el.classList.contains('is-active'));
            if (isOurs) {
                if (!panel.classList.contains('is-active')) {
                    panel.classList.add('is-active');
                }
                if (!button.classList.contains('emby-tab-button-active')) {
                    highlighted.forEach((el) => el.classList.remove('emby-tab-button-active'));
                    button.classList.add('emby-tab-button-active');
                }
                strayPanels.forEach((el) => el.classList.remove('is-active'));
            } else {
                // Not our tab: only take back what we own.
                strayPanels.filter((el) => el.id.indexOf('customTab_') === 0)
                    .forEach((el) => el.classList.remove('is-active'));
                // If that leaves nothing shown (a custom panel had been left
                // showing in place of the selected tab, #46), let Jellyfin apply
                // its own selection again so that tab is shown and refreshed.
                if (!panel.classList.contains('is-active') && !panels.some((el) => el.classList.contains('is-active'))) {
                    tabsElem.selectedIndex(selected);
                }
            }
        },

        // Open the tab a ctTab link names, once its button exists. Jellyfin
        // already selected the link's number when Home rendered, which may
        // have been stale. A tab the user picks first spends the link.
        applyLinkedTab: function(tabsElem) {
            const link = this.resolveLinkedTab();
            if (!link || link.id === null || !tabsElem || typeof tabsElem.selectedIndex !== 'function') {
                return;
            }
            if (this.appliedLink && this.appliedLink.hash === window.location.hash
                && (this.appliedLink.tabs === tabsElem || this.appliedLink.byUser)) {
                return;
            }

            const target = link.index === null ? 0 : link.index + 2;
            const button = tabsElem.querySelectorAll('.emby-tab-button')[target];
            if (!button || button.getAttribute('data-index') !== String(target)) {
                return;
            }

            this.appliedLink = { hash: window.location.hash, tabs: tabsElem, byUser: false };
            if (tabsElem.selectedIndex() !== target || !button.classList.contains('emby-tab-button-active')) {
                this.selectingTab = true;
                try {
                    tabsElem.selectedIndex(target);
                } finally {
                    this.selectingTab = false;
                }
            }
        },

        // A click is recorded 120 ms after it is shown, without a DOM change
        // we could observe, so re-check when Jellyfin reports it. A tab picked
        // by the user (anything but the URL's own number, which is Jellyfin's
        // first selection, or any pick right after input in the tab strip)
        // spends a pending ctTab link.
        watchTabs: function(tabsElem) {
            if (!tabsElem || tabsElem === this.watchedTabs) {
                return;
            }
            this.watchedTabs = tabsElem;
            tabsElem.addEventListener('tabchange', () => this.scheduleSync());
            tabsElem.addEventListener('beforetabchange', (e) => {
                if (this.selectingTab) {
                    return;
                }
                const picked = parseInt(e.detail && e.detail.selectedTabIndex, 10);
                const tab = parseInt(this.hashParam('tab'), 10);
                const userInput = Date.now() - this.lastTabStripInput < 1000;
                if (!userInput && this.correctedFrom !== null && picked === this.correctedFrom) {
                    // Jellyfin's own first selection, made with the link's stale
                    // number after we already corrected it: apply the link again.
                    this.correctedFrom = null;
                    this.appliedLink = null;
                    this.scheduleSync();
                    return;
                }
                if (picked !== (isNaN(tab) ? 0 : tab) || userInput) {
                    this.appliedLink = { hash: window.location.hash, tabs: tabsElem, byUser: true };
                }
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
            if (document.body.classList.contains('dashboardDocument')) return null;
            return document.querySelector('header.MuiAppBar-root .MuiToolbar-root .MuiStack-root');
        },

        // Below roughly 768px the header links unmount and MUI renders a drawer
        getModernDrawerList: function() {
            if (document.body.classList.contains('dashboardDocument')) return null;
            return document.querySelector('.MuiDrawer-paper ul.MuiList-root');
        },

        isModernLayout: function() {
            return !!this.getModernBar() || !!this.getModernDrawerList();
        },

        syncModern: function() {
            if (this.isHomeHash()) {
                this.refreshOnVisit();
            }
            if (!this.configs.length) {
                this.removeModernTabs();
            } else {
                this.ensureModernStyles();
                this.ensureModernTabs();
            }
            // Even with no tabs left, a saved link to a deleted tab must land on Home.
            this.renderModernContent();
            // Jellyfin still selects the link's number in the hidden legacy tab
            // strip; a link to a deleted tab must land on Home there too.
            this.applyLinkedTab(document.querySelector('.emby-tabs-slider')?.closest('[is="emby-tabs"]'));
        },

        ensureModernStyles: function() {
            if (document.getElementById('customTabsModernStyles')) {
                return;
            }

            const style = document.createElement('style');
            style.id = 'customTabsModernStyles';
            style.textContent = '[id^="customTabButton_"][aria-current="page"]{background-color:rgba(255,255,255,.12);}'
                + 'main > [data-custom-tab]{min-height:calc(100vh - 48px);}'
                + 'main.customTabActive > *:not([data-custom-tab]){display:none !important;}';
            document.head.appendChild(style);
        },

        // Drop every header link, drawer item and content block we added, so
        // the next sync rebuilds them from the current tab list.
        removeModernTabs: function() {
            document.querySelectorAll('a[id^="customTabButton_"]').forEach((el) => el.remove());
            document.querySelectorAll('[id^="customTabDrawerButton_"]').forEach((el) => (el.closest('li') || el).remove());
            document.querySelectorAll('main > [data-custom-tab]').forEach((el) => el.remove());
            document.querySelector('main')?.classList.remove('customTabActive');
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
                        || Array.from(bar.children).find((el) => el.tagName === 'A' && el.id.indexOf('customTabButton_') !== 0);

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

                    // Only a drawer that links to Home tabs is the navigation
                    // drawer; any other MUI drawer (Dashboard, settings) is not.
                    const items = Array.from(list.children).filter((el) => el.tagName === 'LI');
                    const template = items.find((el) => {
                        const link = el.querySelector('a');
                        return link && link.id.indexOf('customTabDrawerButton_') !== 0
                            && (link.getAttribute('href') || '').indexOf('#/home?tab=') === 0;
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
            link.setAttribute('href', this.tabLink(index));
            link.removeAttribute('aria-current');
            this.setModernLabel(link, config.Title);

            link.querySelectorAll('.MuiButton-startIcon, .MuiListItemIcon-root, svg')
                .forEach((icon) => icon.remove());
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
            const link = this.resolveLinkedTab();
            return link ? link.index : null;
        },

        renderModernContent: function() {
            const main = document.querySelector('main');
            if (!main) {
                return;
            }

            const index = this.getModernTabIndex();
            // Only our own direct child: anything else with a customTab_ ID in
            // <main> belongs to the hidden legacy Home view.
            const existing = main.querySelector(':scope > [data-custom-tab]');

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
            const html = this.configs[index].ContentHtml || '';
            if (existing && existing.id === wantedId && this.renderedTabs.get(existing) === html) {
                this.setModernSelected(index);
                return;
            }

            if (existing) {
                existing.remove();
            }

            const content = document.createElement('div');
            content.id = wantedId;
            content.setAttribute('data-custom-tab', '');
            content.setAttribute('data-index', index + 2);
            this.setInnerHTMLWithScripts(content, html);
            this.renderedTabs.set(content, html);
            main.appendChild(content);
            this.setModernSelected(index);
            console.debug(`CustomTabs: Rendered ${wantedId} into main`);
        },

        setModernSelected: function(index) {
            const links = [];
            [this.getModernBar(), this.getModernDrawerList()].forEach((container) => {
                if (container) {
                    links.push(...container.querySelectorAll('a[id^="customTabButton_"], [id^="customTabDrawerButton_"]'));
                }
            });
            links.forEach((link) => {
                const own = parseInt(link.id.replace(/\D+/g, ''), 10);
                if (index !== null && own === index) {
                    if (link.getAttribute('aria-current') !== 'page') link.setAttribute('aria-current', 'page');
                } else if (link.hasAttribute('aria-current')) {
                    link.removeAttribute('aria-current');
                }
            });
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

    // Every way Jellyfin navigates ends in a re-check. The page observer
    // catches the DOM changes; these catch navigations that change nothing in
    // the DOM by themselves (a hash change between custom tabs, Back/Forward,
    // returning to the browser tab).
    const resync = () => window.customTabsPlugin.init();
    window.addEventListener("popstate", resync);
    window.addEventListener("hashchange", resync);
    window.addEventListener("pageshow", resync);
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
            resync();
        }
    });

    // Real input in the tab strip, so a click on the tab a stale link's
    // number points at still counts as the user's own pick.
    const noteTabStripInput = (e) => {
        if (e.isTrusted && e.target && e.target.closest && e.target.closest('[is="emby-tabs"]')) {
            window.customTabsPlugin.lastTabStripInput = Date.now();
        }
    };
    document.addEventListener('pointerdown', noteTabStripInput, { capture: true, passive: true });
    document.addEventListener('keydown', noteTabStripInput, { capture: true, passive: true });

    const originalPushState = history.pushState;
    history.pushState = function() {
        originalPushState.apply(history, arguments);
        resync();
    };

    const originalReplaceState = history.replaceState;
    history.replaceState = function() {
        originalReplaceState.apply(history, arguments);
        resync();
    };

    console.log('CustomTabs: Plugin setup complete');
}
