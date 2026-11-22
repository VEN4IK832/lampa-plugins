/*!
 * Dreamerscast plugin for Lampa
 * Парсит релизы dreamerscast.com, деобфусцирует Playerjs-payload, кидает m3u8
 * в Vimu через Android intent. Fallback — родной Lampa.Player.
 */

(function () {
    'use strict';

    if (window.dreamerscast_plugin_ready) return;
    window.dreamerscast_plugin_ready = true;

    var PLUGIN_ID    = 'dreamerscast';
    var PLUGIN_NAME  = 'Dreamerscast';
    var HOST         = 'https://dreamerscast.com';
    var VIMU_PACKAGE = 'net.gtvbox.videoplayer';

    // =======================================================================
    // Net
    // =======================================================================
    var Net = {
        proxy: '',

        get: function (url, cb, err) {
            var final = Net.proxy ? (Net.proxy + encodeURIComponent(url)) : url;
            var xhr = new XMLHttpRequest();
            xhr.open('GET', final, true);
            xhr.timeout = 20000;
            xhr.setRequestHeader('Accept', 'text/html,*/*');
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 400) cb(xhr.responseText);
                else (err || function () {})(new Error('HTTP ' + xhr.status));
            };
            xhr.onerror   = function () { (err || function () {})(new Error('net')); };
            xhr.ontimeout = function () { (err || function () {})(new Error('timeout')); };
            xhr.send();
        },

        absolute: function (url) {
            if (!url) return '';
            if (url.indexOf('//') === 0) return 'https:' + url;
            if (url.charAt(0) === '/')   return HOST + url;
            return url;
        }
    };

    // =======================================================================
    // Parser
    // =======================================================================
    var Parser = {
        /**
         * Playerjs на dreamerscast использует обфускацию:
         *   1. JSON → UTF-8 → base64
         *   2. префикс '#2'
         *   3. в середину base64 вставлены куски вида `//<junk>==` как разделители
         * Декодер: убрать префикс '#2', вырезать все `/\/\/[^=]*==/`, допэддить до %4=0,
         * декодировать как UTF-8 base64, распарсить JSON.
         */
        decodePlayerjsPayload: function (rawWithPrefix) {
            if (!rawWithPrefix) return null;
            var raw = rawWithPrefix.indexOf('#2') === 0 ? rawWithPrefix.slice(2) : rawWithPrefix;
            var cleaned = raw.replace(/\/\/[^=]*==/g, '');
            while (cleaned.length % 4 !== 0) cleaned += '=';

            try {
                var bin = atob(cleaned);
                var bytes = new Uint8Array(bin.length);
                for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                var json = Parser.utf8Decode(bytes);
                return JSON.parse(json);
            } catch (e) { return null; }
        },

        utf8Decode: function (bytes) {
            if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
            // fallback для древних webview
            var out = '', i = 0;
            while (i < bytes.length) {
                var c = bytes[i++];
                if (c < 0x80) out += String.fromCharCode(c);
                else if (c < 0xE0) out += String.fromCharCode(((c & 0x1F) << 6) | (bytes[i++] & 0x3F));
                else if (c < 0xF0) {
                    var c2 = bytes[i++], c3 = bytes[i++];
                    out += String.fromCharCode(((c & 0x0F) << 12) | ((c2 & 0x3F) << 6) | (c3 & 0x3F));
                } else i += 3;
            }
            return out;
        },

        // Строка `file` эпизода выглядит как: "<dash_url>.mpd or <hls_url>.m3u8".
        // Нам нужен HLS — Vimu и Lampa.Player его жуют.
        pickHls: function (fileStr) {
            if (!fileStr || typeof fileStr !== 'string') return '';
            var parts = fileStr.split(/\s+or\s+/i);
            for (var i = 0; i < parts.length; i++) {
                if (parts[i].indexOf('.m3u8') >= 0) return parts[i].trim();
            }
            return parts[parts.length - 1].trim();
        },

        // Извлекаем качества из urlset-URL: `.../hls/<uuid>/<uuid>_,1080,720,low,aac,.mp4.urlset/master.m3u8`
        // Можно собрать прямые ссылки на каждое качество через подмену сегмента.
        expandQualities: function (hlsMaster) {
            var out = { master: hlsMaster };
            // ...uuid_,QUALITIES,aac,.mp4.urlset/master.m3u8
            var m = /_,([^,]+(?:,[^,]+)*),[a-z]+,\.mp4\.urlset/i.exec(hlsMaster);
            if (!m) return out;
            var qualities = m[1].split(',').filter(function (q) { return /^\d+$/.test(q); });
            // Master уже отдаёт адаптив — качественные варианты пусть Vimu/hls.js выберут сам.
            qualities.forEach(function (q) { out[q + 'p'] = hlsMaster; });
            return out;
        },

        parseRelease: function (html, releaseUrl) {
            var movie = {
                id:          Parser.extractReleaseId(releaseUrl),
                url:         releaseUrl,
                title:       Parser.extractMeta(html, 'og:title') || Parser.extractTitle(html),
                poster:      Net.absolute(Parser.extractMeta(html, 'og:image')),
                description: Parser.stripTags(Parser.extractMeta(html, 'og:description')),
                translations: [{ id: 'default', name: 'Dream Cast' }],
                seasons: []
            };

            // Playerjs payload
            var m = /Playerjs\(["']#2([^"']+)["']/.exec(html);
            if (!m) return movie;

            var data = Parser.decodePlayerjsPayload('#2' + m[1]);
            if (!data) return movie;

            var files = Array.isArray(data.file) ? data.file : [{
                title: data.title || data.label || 'Серия 1',
                file:  data.file,
                poster: data.poster
            }];

            movie.seasons = [{
                season: 1,
                episodes: files.map(function (f, i) {
                    var hls = Parser.pickHls(f.file);
                    return {
                        episode: i + 1,
                        title:   f.title || ('Серия ' + (i + 1)),
                        poster:  f.poster || movie.poster,
                        streams: Parser.expandQualities(hls)
                    };
                })
            }];

            return movie;
        },

        extractReleaseId: function (url) {
            var m = /release\/(\d+)/.exec(url || '');
            return m ? m[1] : '';
        },

        extractMeta: function (html, name) {
            var patterns = [
                new RegExp('<meta[^>]+property=["\']' + name + '["\'][^>]*content=["\']([^"\']+)["\']', 'i'),
                new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]*property=["\']' + name + '["\']', 'i'),
                new RegExp('<meta[^>]+name=["\']' + name + '["\'][^>]*content=["\']([^"\']+)["\']', 'i')
            ];
            for (var i = 0; i < patterns.length; i++) {
                var m = patterns[i].exec(html);
                if (m) return Parser.decodeHTML(m[1]);
            }
            return '';
        },

        extractTitle: function (html) {
            var m = /<title>([^<]+)<\/title>/i.exec(html);
            return m ? Parser.decodeHTML(m[1].trim()) : '';
        },

        decodeHTML: function (s) {
            return (s || '')
                .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ');
        },

        stripTags: function (s) { return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
    };

    // =======================================================================
    // Launcher — Vimu intent + fallback
    // =======================================================================
    var Launcher = {
        isAndroid: function () {
            return /Android/i.test(navigator.userAgent) ||
                   !!(window.Lampa && window.Lampa.Platform && Lampa.Platform.get() === 'android');
        },

        toVimu: function (url, title) {
            if (!url) return false;
            var intentUrl = 'intent:' + url + '#Intent' +
                            ';type=video/*' +
                            ';package=' + VIMU_PACKAGE +
                            ';S.title=' + encodeURIComponent(title || 'Lampa') +
                            ';S.secure_uri=true' +
                            ';end';

            if (window.Lampa && Lampa.Android && typeof Lampa.Android.openIntent === 'function') {
                try { Lampa.Android.openIntent(intentUrl); return true; } catch (e) {}
            }
            if (window.Android && typeof window.Android.openUrl === 'function') {
                try { window.Android.openUrl(intentUrl); return true; } catch (e) {}
            }
            if (window.AndroidJS && typeof window.AndroidJS.external === 'function') {
                try { window.AndroidJS.external('open', intentUrl); return true; } catch (e) {}
            }
            try { window.location.href = intentUrl; return true; } catch (e) {}
            return false;
        },

        toLampaPlayer: function (url, qualityObj, title) {
            if (!window.Lampa || !Lampa.Player) return false;
            Lampa.Player.play({ url: url, quality: qualityObj || {}, title: title || 'Lampa' });
            return true;
        },

        play: function (streams, title) {
            var best = Launcher.bestStream(streams);
            if (!best) { if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Нет потока'); return; }

            var prefer = (window.Lampa && Lampa.Storage && Lampa.Storage.get('dreamerscast_player', 'vimu')) || 'vimu';
            if (prefer === 'vimu' && Launcher.isAndroid() && Launcher.toVimu(best.url, title)) return;
            Launcher.toLampaPlayer(best.url, streams, title);
        },

        bestStream: function (streams) {
            if (!streams) return null;
            if (streams.master) return { quality: 'auto', url: streams.master };
            var order = ['1080p', '720p', '480p', '360p'];
            for (var i = 0; i < order.length; i++) if (streams[order[i]]) return { quality: order[i], url: streams[order[i]] };
            for (var k in streams) return { quality: k, url: streams[k] };
            return null;
        }
    };

    // =======================================================================
    // API
    // =======================================================================
    var API = {
        search: function (query, cb, err) {
            // dreamerscast поиск: /home/search с query parameter
            Net.get(HOST + '/home/search?query=' + encodeURIComponent(query), function (html) {
                cb(API.parseSearch(html));
            }, err);
        },

        parseSearch: function (html) {
            var out = [], seen = {};
            var rx = /<a[^>]+href=["'](\/home\/release\/\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
            var m;
            while ((m = rx.exec(html)) !== null) {
                if (seen[m[1]]) continue;
                seen[m[1]] = 1;
                var inner = m[2];
                var titleM = /<(?:h\d|span|div)[^>]*>([^<]{3,})</.exec(inner) || /title=["']([^"']+)["']/.exec(m[0]);
                var imgM   = /<img[^>]+src=["']([^"']+)["']/.exec(inner);
                out.push({
                    id:     Parser.extractReleaseId(m[1]),
                    url:    Net.absolute(m[1]),
                    title:  titleM ? Parser.decodeHTML(titleM[1]).trim() : m[1],
                    poster: imgM ? Net.absolute(imgM[1]) : ''
                });
            }
            return out;
        },

        release: function (url, cb, err) {
            Net.get(url, function (html) { cb(Parser.parseRelease(html, url)); }, err);
        }
    };

    // =======================================================================
    // UI Component
    // =======================================================================
    function Component(object) {
        var scroll  = new Lampa.Scroll({ mask: true, over: true });
        var files   = new Lampa.Explorer(object);
        var html    = $('<div class="dreamerscast"></div>');
        var movie   = null;

        this.create = function () { return this.render(); };
        this.render = function () { return files.render(); };

        this.start = function () {
            if (!object.url) { this.renderSearch(); return; }
            this.loading(true);
            API.release(object.url, function (m) {
                movie = m;
                this.build();
                this.loading(false);
                Lampa.Controller.enable('content');
            }.bind(this), function () { this.empty('Не удалось загрузить релиз'); }.bind(this));
        };

        this.renderSearch = function () {
            html.empty();
            var input = $('<div class="dreamerscast-search"><input type="text" placeholder="Название..." class="selector"></div>');
            var results = $('<div class="dreamerscast-results"></div>');
            html.append(input).append(results);

            input.find('input').on('change keyup', function (e) {
                if (e.type === 'keyup' && e.keyCode !== 13) return;
                var q = $(this).val();
                if (!q || q.length < 2) return;
                results.html('<div class="empty__title">Поиск...</div>');
                API.search(q, function (list) {
                    results.empty();
                    if (!list.length) { results.html('<div class="empty__title">Ничего</div>'); return; }
                    list.forEach(function (it) {
                        var card = $(
                            '<div class="selector dreamerscast-card">' +
                              '<div class="dreamerscast-card__img"><img src="' + it.poster + '"></div>' +
                              '<div class="dreamerscast-card__title">' + it.title + '</div>' +
                            '</div>'
                        );
                        card.on('hover:enter', function () {
                            Lampa.Activity.push({ url: it.url, title: it.title, component: PLUGIN_ID, page: 1 });
                        });
                        results.append(card);
                    });
                }, function () { results.html('<div class="empty__title">Ошибка сети</div>'); });
            });

            scroll.append(html);
            files.appendFiles(this);
            this.bindController();
        };

        this.build = function () {
            html.empty();
            var header = $(
                '<div class="dreamerscast-head">' +
                  '<div class="dreamerscast-head__poster"><img src="' + (movie.poster || '') + '"></div>' +
                  '<div class="dreamerscast-head__meta">' +
                    '<div class="dreamerscast-head__title">' + (movie.title || '') + '</div>' +
                    '<div class="dreamerscast-head__desc">' + (movie.description || '') + '</div>' +
                  '</div>' +
                '</div>'
            );
            html.append(header);

            (movie.seasons || []).forEach(function (season) {
                html.append($('<div class="dreamerscast-season-title">Серии</div>'));
                var row = $('<div class="dreamerscast-row"></div>');
                (season.episodes || []).forEach(function (ep) {
                    var item = $(
                        '<div class="selector dreamerscast-ep">' +
                          '<div class="dreamerscast-ep__num">' + ep.episode + '</div>' +
                          '<div class="dreamerscast-ep__title">' + ep.title + '</div>' +
                        '</div>'
                    );
                    item.on('hover:enter', function () {
                        Launcher.play(ep.streams, movie.title + ' — ' + ep.title);
                    });
                    row.append(item);
                });
                html.append(row);
            });

            scroll.append(html);
            files.appendFiles(this);
            this.bindController();
        };

        this.bindController = function () {
            Lampa.Controller.add('content', {
                toggle: function () {
                    Lampa.Controller.collectionSet(scroll.render());
                    Lampa.Controller.collectionFocus(false, scroll.render());
                },
                left:  function () { Lampa.Controller.toggle('menu'); },
                up:    function () { if (window.Navigator) Navigator.move('up');    },
                down:  function () { if (window.Navigator) Navigator.move('down');  },
                right: function () { if (window.Navigator) Navigator.move('right'); },
                back:  this.back
            });
        };

        this.append  = function (el) { scroll.append(el); };
        this.body    = function ()   { return scroll.render(); };
        this.loading = function (on) { files.loading(on); };
        this.empty   = function (msg) {
            this.loading(false);
            html.empty().append('<div class="empty"><div class="empty__title">' + (msg || 'Пусто') + '</div></div>');
            scroll.append(html);
            files.appendFiles(this);
        };
        this.back    = function () { Lampa.Activity.backward(); };
        this.pause   = function () {};
        this.stop    = function () {};
        this.destroy = function () { scroll.destroy(); files.destroy(); html.remove(); movie = null; };
    }

    // =======================================================================
    // Settings + Menu + boot
    // =======================================================================
    function addSettings() {
        if (!window.Lampa || !Lampa.SettingsApi) return;
        Lampa.SettingsApi.addComponent({ component: PLUGIN_ID, name: PLUGIN_NAME, icon: '' });
        Lampa.SettingsApi.addParam({
            component: PLUGIN_ID,
            param: { name: 'dreamerscast_player', type: 'select', values: { vimu: 'Vimu', internal: 'Lampa' }, default: 'vimu' },
            field: { name: 'Плеер', description: 'Куда отправлять поток' },
            onChange: function () {}
        });
        Lampa.SettingsApi.addParam({
            component: PLUGIN_ID,
            param: { name: 'dreamerscast_proxy', type: 'input', default: '' },
            field: { name: 'CORS-прокси', description: 'Префикс, напр. https://proxy.example.com/?url=' },
            onChange: function (v) { Net.proxy = v || ''; }
        });
        Net.proxy = Lampa.Storage.get('dreamerscast_proxy', '') || '';
    }

    function addMenuButton() {
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
        btn.on('hover:enter', function () {
            Lampa.Activity.push({ url: '', title: PLUGIN_NAME, component: PLUGIN_ID, page: 1 });
        });
        $('.menu .menu__list').eq(0).append(btn);
    }

    function addStyles() {
        var css =
            '.dreamerscast-head{display:flex;gap:1.5em;margin:1em 0 2em;}' +
            '.dreamerscast-head__poster img{width:14em;border-radius:.6em;}' +
            '.dreamerscast-head__title{font-size:1.8em;font-weight:600;}' +
            '.dreamerscast-head__desc{opacity:.8;line-height:1.4;max-width:40em;margin-top:.5em;}' +
            '.dreamerscast-row{display:flex;flex-wrap:wrap;gap:.6em;margin:1em 0;}' +
            '.dreamerscast-season-title{font-size:1.2em;font-weight:600;margin:1.5em 0 .5em;}' +
            '.dreamerscast-ep{width:12em;padding:.8em;background:rgba(255,255,255,.05);border-radius:.5em;}' +
            '.dreamerscast-ep.focus{background:#fff;color:#000;}' +
            '.dreamerscast-ep__num{font-size:1.4em;font-weight:700;}' +
            '.dreamerscast-ep__title{opacity:.8;font-size:.9em;margin-top:.3em;}' +
            '.dreamerscast-search input{width:30em;padding:.8em 1em;background:rgba(255,255,255,.08);border:0;border-radius:.4em;color:#fff;font-size:1em;}' +
            '.dreamerscast-results{display:flex;flex-wrap:wrap;gap:1em;margin-top:1.5em;}' +
            '.dreamerscast-card{width:12em;}' +
            '.dreamerscast-card__img img{width:100%;border-radius:.5em;}' +
            '.dreamerscast-card__title{margin-top:.5em;font-size:.9em;}' +
            '.dreamerscast-card.focus{transform:scale(1.05);}';
        $('<style>' + css + '</style>').appendTo('head');
    }

    function boot() {
        Lampa.Component.add(PLUGIN_ID, Component);
        addStyles();
        addSettings();
        if (window.appready) addMenuButton();
        else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') addMenuButton(); });
    }

    if (window.Lampa) boot();
    else {
        var t = setInterval(function () { if (window.Lampa) { clearInterval(t); boot(); } }, 200);
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { Parser: Parser, Launcher: Launcher, API: API, Net: Net };
    }
})();
