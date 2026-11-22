/*!
 * Dreamerscast plugin for Lampa — v2 (simple overlay flow)
 * Вместо Activity/Component — Lampa.Input → Reguest → Lampa.Select → Lampa.Player
 */

(function () {
    'use strict';
    if (window.dreamerscast_v2_ready) return;
    window.dreamerscast_v2_ready = true;

    var PLUGIN_ID    = 'dreamerscast';
    var PLUGIN_NAME  = 'Dreamerscast';
    var HOST         = 'https://dreamerscast.com';
    var VIMU_PACKAGE = 'net.gtvbox.videoplayer';

    // =======================================================================
    // Net — используем Lampa.Reguest (он часто проксирует через свой CORS-прокси)
    // =======================================================================
    var Net = {
        get: function (url, cb, err) {
            var req = new Lampa.Reguest();
            req.timeout(20000);
            req.silent(url, function (text) { cb(text); }, function (xhr, status) {
                (err || function(){})(new Error('HTTP ' + (xhr && xhr.status || status)));
            }, false, { dataType: 'text' });
        }
    };

    // =======================================================================
    // Parser
    // =======================================================================
    var Parser = {
        decodePlayerjsPayload: function (rawWithPrefix) {
            if (!rawWithPrefix) return null;
            var raw = rawWithPrefix.indexOf('#2') === 0 ? rawWithPrefix.slice(2) : rawWithPrefix;
            var cleaned = raw.replace(/\/\/[^=]*==/g, '');
            while (cleaned.length % 4 !== 0) cleaned += '=';
            try {
                var bin = atob(cleaned);
                var bytes = new Uint8Array(bin.length);
                for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                var json = new TextDecoder('utf-8').decode(bytes);
                return JSON.parse(json);
            } catch (e) { return null; }
        },

        pickHls: function (fileStr) {
            if (!fileStr) return '';
            var parts = fileStr.split(/\s+or\s+/i);
            for (var i = 0; i < parts.length; i++) if (parts[i].indexOf('.m3u8') >= 0) return parts[i].trim();
            return parts[parts.length - 1].trim();
        },

        extractMeta: function (html, name) {
            var rx = new RegExp('<meta[^>]+property=["\']' + name + '["\'][^>]*content=["\']([^"\']+)["\']', 'i');
            var m = rx.exec(html);
            return m ? Parser.decodeHtml(m[1]) : '';
        },

        decodeHtml: function (s) {
            return (s || '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
                .replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&nbsp;/g,' ');
        },

        parseRelease: function (html) {
            var movie = {
                title: Parser.extractMeta(html, 'og:title'),
                poster: (Parser.extractMeta(html, 'og:image') || '').replace(/^http:/, 'https:'),
                episodes: []
            };
            var m = /Playerjs\(["']#2([^"']+)["']/.exec(html);
            if (!m) return { movie: movie, error: 'Playerjs payload не найден' };
            var data = Parser.decodePlayerjsPayload('#2' + m[1]);
            if (!data) return { movie: movie, error: 'Не декодируется payload' };
            var files = Array.isArray(data.file) ? data.file : [{ title: 'Серия 1', file: data.file }];
            movie.episodes = files.map(function (f, i) {
                return { num: i + 1, title: f.title || 'Серия ' + (i + 1), hls: Parser.pickHls(f.file) };
            });
            return { movie: movie };
        },

        parseSearch: function (html) {
            var out = [], seen = {};
            var rx = /<a[^>]+href=["'](\/home\/release\/\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
            var m;
            while ((m = rx.exec(html)) !== null) {
                if (seen[m[1]]) continue;
                seen[m[1]] = 1;
                var inner = m[2];
                var titleM = /<(?:h\d|span|div)[^>]*>([^<]{3,})</.exec(inner) ||
                             /alt=["']([^"']+)["']/.exec(inner) ||
                             /title=["']([^"']+)["']/.exec(m[0]);
                var imgM = /<img[^>]+(?:src|data-src)=["']([^"']+)["']/.exec(inner);
                var title = titleM ? Parser.decodeHtml(titleM[1]).trim() : m[1];
                var abs = HOST + m[1];
                out.push({
                    title: title,
                    url: abs,
                    poster: imgM ? (imgM[1].indexOf('http') === 0 ? imgM[1] : HOST + imgM[1]) : ''
                });
            }
            return out;
        }
    };

    // =======================================================================
    // Launcher
    // =======================================================================
    var Launcher = {
        isAndroid: function () {
            return /Android/i.test(navigator.userAgent) ||
                   !!(window.Lampa && Lampa.Platform && Lampa.Platform.get() === 'android');
        },

        toVimu: function (url, title) {
            if (!url) return false;
            var intent = 'intent:' + url + '#Intent' +
                         ';type=video/*' +
                         ';package=' + VIMU_PACKAGE +
                         ';S.title=' + encodeURIComponent(title || 'Lampa') +
                         ';S.secure_uri=true;end';
            if (Lampa.Android && typeof Lampa.Android.openIntent === 'function') {
                try { Lampa.Android.openIntent(intent); return true; } catch (e) {}
            }
            if (window.Android && typeof window.Android.openUrl === 'function') {
                try { window.Android.openUrl(intent); return true; } catch (e) {}
            }
            try { window.location.href = intent; return true; } catch (e) {}
            return false;
        },

        play: function (url, title) {
            if (!url) { Lampa.Noty.show('Нет потока'); return; }
            var prefer = Lampa.Storage.get('dreamerscast_player', 'internal');
            if (prefer === 'vimu' && Launcher.isAndroid() && Launcher.toVimu(url, title)) return;
            Lampa.Player.play({ url: url, title: title, quality: {} });
        }
    };

    // =======================================================================
    // Flow: search → results → episodes → play
    // =======================================================================
    function openSearch() {
        Lampa.Input.edit({
            value: Lampa.Storage.get('dreamerscast_last_query', ''),
            free: true,
            nosave: false
        }, function (query) {
            if (!query) return;
            Lampa.Storage.set('dreamerscast_last_query', query);
            doSearch(query);
        });
    }

    function doSearch(query) {
        Lampa.Noty.show('Ищу: ' + query);
        var url = HOST + '/home/search?query=' + encodeURIComponent(query);
        Net.get(url, function (html) {
            var results = Parser.parseSearch(html);
            if (!results.length) { Lampa.Noty.show('Ничего не найдено'); return; }
            showResults(results);
        }, function (e) {
            Lampa.Noty.show('Ошибка: ' + e.message);
        });
    }

    function showResults(results) {
        var items = results.map(function (r) {
            return { title: r.title, subtitle: r.url.replace(HOST, ''), _data: r };
        });
        Lampa.Select.show({
            title: 'Результаты поиска',
            items: items,
            onBack: function () { Lampa.Controller.toggle('menu'); },
            onSelect: function (sel) { openRelease(sel._data); }
        });
    }

    function openRelease(data) {
        Lampa.Noty.show('Загружаю релиз...');
        Net.get(data.url, function (html) {
            var r = Parser.parseRelease(html);
            if (r.error) { Lampa.Noty.show(r.error); return; }
            if (!r.movie.episodes.length) { Lampa.Noty.show('Нет серий'); return; }
            showEpisodes(r.movie);
        }, function (e) {
            Lampa.Noty.show('Ошибка: ' + e.message);
        });
    }

    function showEpisodes(movie) {
        var items = movie.episodes.map(function (ep) {
            return { title: ep.title, subtitle: 'HLS 1080p/720p', _data: ep };
        });
        Lampa.Select.show({
            title: movie.title || 'Серии',
            items: items,
            onBack: function () { openSearch(); },
            onSelect: function (sel) {
                var ep = sel._data;
                Launcher.play(ep.hls, (movie.title || '') + ' — ' + ep.title);
            }
        });
    }

    // =======================================================================
    // Settings + menu button + boot
    // =======================================================================
    function addSettings() {
        if (!Lampa.SettingsApi) return;
        Lampa.SettingsApi.addComponent({ component: PLUGIN_ID, name: PLUGIN_NAME, icon: '' });
        Lampa.SettingsApi.addParam({
            component: PLUGIN_ID,
            param: { name: 'dreamerscast_player', type: 'select',
                     values: { internal: 'Lampa Player', vimu: 'Vimu (Android)' },
                     default: 'internal' },
            field: { name: 'Плеер', description: 'Куда отправлять поток' },
            onChange: function () {}
        });
    }

    function addMenuButton() {
        if (document.querySelector('[data-action="' + PLUGIN_ID + '"]')) return;
        var btn = $(
            '<li class="menu__item selector" data-action="' + PLUGIN_ID + '">' +
              '<div class="menu__ico">' +
                '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                  '<polygon points="5 3 19 12 5 21 5 3"></polygon>' +
                '</svg>' +
              '</div>' +
              '<div class="menu__text">' + PLUGIN_NAME + '</div>' +
            '</li>'
        );
        btn.on('hover:enter', openSearch);
        $('.menu .menu__list').eq(0).append(btn);
    }

    function boot() {
        addSettings();
        if (window.appready) addMenuButton();
        else Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') addMenuButton();
        });
    }

    if (window.Lampa) boot();
    else {
        var t = setInterval(function () { if (window.Lampa) { clearInterval(t); boot(); } }, 200);
    }
})();
