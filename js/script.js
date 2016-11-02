$(function(){
	var Database;
	var S = {
		interval: {
			update_view: 10000,
			db_save: 5000
		},
		settings: {}
	};
	
	var EXIF = require('exif-reader');
	var SizeOf = require('image-size');
	var AudioMetaData = require('audio-metadata');
	var EncodingDetector = require("jschardet");
	var Iconv = require('iconv-lite');
	
	var Preprocessor = {
		auto_tags: function(filepath, hash, data){
			var self = this;
			var ext = filepath.match(/\.(\w+)$/);
			ext = (ext && ext[1]) ? ext[1].toLowerCase() : '';
			var format = ext;
			switch (ext) {
				case 'pdf':
					this.from_pdf(hash, data);
					format = 'PDF';
					break;
				case 'fb2':
					var encoding = this.charset(hash, data);
					this.from_fb2(hash, data, encoding);
					format = 'FB2';
					break;
				case 'htm':
				case 'html':
					var encoding = this.charset(hash, data);
					this.from_html(hash, data, encoding);
					format = 'HTML';
					break;
				case 'txt':
					this.charset(hash, data);
					format = 'TXT';
					break;
				case 'jpeg':
				case 'jpe':
				case 'jpg':
				case 'jfif':
				case 'jif':
					this.from_exif(hash, data);
					this.image_size(hash, filepath);
					format = 'JPEG';
					break;
				case 'tiff':
				case 'tif':
					this.from_exif(hash, data);
					this.image_size(hash, filepath);
					format = 'TIFF';
					break;
				case 'png':
				case 'bmp':
				case 'gif':
				case 'psd':
				case 'svg':
					this.image_size(hash, filepath);
					format = ext.toUpperCase();
					break;
				case 'webp':
					this.image_size(hash, filepath);
					format = 'WebP';
					break;
				case 'mp3':
					this.from_mp3(hash, data);
					format = 'MP3';
					break;
				case 'ogg':
				case 'oga':
					this.from_ogg(hash, data);
					format = 'OGG';
					break;
				default:
					console.log('No processor for ',ext);
					break;
			}
			if (ext) {
				Database.add_tag({hash: hash}, {key: '#Format', value: format, auto: false});
			}
		},
		image_size: function(hash, filepath){
			var dimensions = SizeOf(filepath);
			Database.add_tags({hash: hash}, dimensions || {}, true);
		},
		from_pdf: function(hash, data){
			var pdf_file = new Uint8Array(data);
			PDFJS.getDocument(pdf_file).promise.then(function(doc){
				doc.getMetadata().then(function(metadata) {
					if (metadata.info) {
						Database.add_tags({hash: hash}, metadata.info, true);
					}
				}).catch(function(err) { /* Error getting metadata */ });
			}).catch(function(err) { /* Error getting PDF */ });
		},
		from_exif: function(hash, data){
			var exif_container = data.indexOf('Exif');
			if (exif_container != -1) {
				try {
					var metadata = EXIF(data.slice(exif_container));
					Database.add_tags({hash: hash}, metadata.image || {}, true);
					Database.add_tags({hash: hash}, metadata.exif  || {}, true);
					Database.add_tags({hash: hash}, metadata.gps   || {}, true);
				}
				catch(e){}
			}
		},
		from_mp3: function(hash, data){
			var metadata = AudioMetaData.id3v2(data);
			Database.add_tags({hash: hash}, metadata || {}, true);
			// metadata = AudioMetaData.id3v1(data);
			// Database.add_tags({hash: hash}, metadata || {}, true);
		},
		from_ogg: function(hash, data){
			var metadata = AudioMetaData.ogg(data);
			Database.add_tags({hash: hash}, metadata || {}, true);
		},
		charset: function(hash, data){
			var charset = EncodingDetector.detect(data);
			Database.add_tags({hash: hash}, charset, true);
			return charset.encoding;
		},
		from_fb2: function(hash, data, enc){
			try {
				var doc = Iconv.decode(data, enc || 'utf-8');
				var $meta = $( $.parseXML( doc ) ).find('description');
				if (!$meta[0]) return;
				var metadata = {};
				var tags = [
					'book-title', 'annotation', 'keywords', 'genre', 'lang', 'src-lang', 'title-info date',
					'author first-name', 'author middle-name', 'author last-name',
					'translator first-name', 'translator middle-name', 'translator last-name',
					'book-name', 'publisher', 'city', 'year', 'isbn',
					'author nickname', 'author homepage', 'author email', 'program-used',
					'document-info date', 'src-url', 'src-ocr', 'version', 'history', 'custom-info'
				];
				tags.forEach(function(tag, i){
					var $tag = $meta.find(tag);
					if ($tag.length > 0){
						metadata[tag] = $tag.map(function(i, t){ return t.innerHTML; }).get().join(', ');
					}
				});
				Database.add_tags({hash: hash}, metadata || {}, true);
			} catch(e) {}
		},
		from_html: function(hash, data, enc){
			try {
				var doc = Iconv.decode(data, enc || 'utf-8');
				var $doc = $( $.parseHTML( doc ) );
				if (!$doc[0]) return;
				if ($doc.length>1) $doc = $('<html>').append($doc); // for malformed HTML
				var metadata = {
					title:       $doc.find('title').text() || $doc.find('body h1').text(),
					description: $doc.find('meta[name="description"]').attr('content'),
					keywords:    $doc.find('meta[name="keywords"]').attr('content')
				};
				Database.add_tags({hash: hash}, metadata || {}, true);
			} catch(e) {}
		}
	};

	var GUI    = require('nw.gui');
	var FS     = require('fs');
	var Sanitize_Filename = require("sanitize-filename");
	var Crypto = require('crypto');
	var Loki   = require('lokijs');
	Database = {
		init: function(){
			var self = this;
			var dfrd = $.Deferred();
			var db_loader = function(){
				self.files     = self.db.getCollection('files')    || self.db.addCollection('files', {exact: ['hash', 'path'], unique: ['hash', 'path']});
				self.tags      = self.db.getCollection('tags')     || self.db.addCollection('tags',  {indices: ['key'], unique: ['key/value']});
				self.settings  = self.db.getCollection('settings') || self.db.addCollection('settings');
				dfrd.resolve();
			};
			self.db = new Loki('files.json', {
				autoload: true, autoloadCallback: db_loader,
				autosave: true, autosaveInterval: S.interval.db_save
			});
			return dfrd.promise();
		}
		,
		NoFile: '-'
		,
		hash_file: function(data){
			return Crypto.createHash('sha1').update(data).digest('hex');
		}
		,
		add_file: function(file, callback){
			var self = this;
			var data = FS.readFileSync(file.path);
			var hash = self.hash_file(data);
			try {
				var inserted = self.files.insert({
					name: file.name,
					path: file.path,
					hash: hash
				});
				if (inserted && callback) { callback(); }
			} catch(e){}
			if (S.settings.read_metadata) {
				Preprocessor.auto_tags(file.path, hash, data);
			}
			return hash;
		}
		,
		get_hash_from_db: function(filepath){
			return this.files.findOne({'path': filepath });
		}
		,
		get_file: function(hash){
			return this.files.findOne({'hash': hash});
		}
		,
		get_file_by_path: function(path){
			return this.files.findOne({'path': path});
		}
		,
		rename_file: function(file, new_name, ext, version){
			var new_name_raw = new_name;
			new_name = Sanitize_Filename(new_name+(version ? ' ('+version+')' : '')+ext, {replacement:'_'});
			var new_path = file.path.substring(0, file.path.lastIndexOf(file.name))+new_name;
			try {
				version = version > 0 ? version+1 : 1;
				if (FS.statSync(new_path).isFile()) return Database.rename_file(file, new_name_raw, ext, version);  // prevent file overwriting
			} catch(e) { /* file not exists */ }
			try {
				FS.renameSync(file.path, new_path);
				this.files.findAndUpdate(
					function(f){
						return (f.hash == file.hash) && (f.path == file.path);
					},
					function(f){
						f.name = new_name;
						f.path = new_path;
						return f;
					}
				);
			}
			catch (e){}
		}
		,
		add_tag: function(file, tag, callback){
			var self = this;
			var hash = file.hash || self.add_file(file, callback);  // just in case
			tag.value = tag.value.trim();
			if (!tag.value) return;
			var tag_obj = {
				hash:  hash,
				key:   tag.key,
				value: tag.value,
				'key/value': hash+'¹'+tag.key+'²'+tag.value,
				auto:  !!tag.auto
			};
			try {
				var inserted = self.tags.insert(tag_obj);
				if (inserted && callback) { callback(); }
			} catch(e){}
			return tag_obj;
		}
		,
		add_tags: function(file, tags, auto, callback){
			var self = this;
			var hash = file.hash || self.add_file(file, callback);
			for (var key in tags){
				var value = tags[key];
				if (!value && value!==0) continue;
				value = (value+'').trim();  // convert numbers, objects and arrays to strings
				if (value.toString() == "[object Object]") continue;
				try {
					var inserted = self.tags.insert({
						hash:  hash,
						key:   '@'+key,
						value: value,
						'key/value': hash+'¹'+'@'+key+'²'+value,
						auto:  !!auto
					});
					if (inserted && callback) { callback(); }
				} catch(e){}
			}
		}
		,
		remove_tag: function(hash, tag){
			var self = this;
			self.tags.removeWhere({ '$and': [{ 'key': tag.key }, { 'value': tag.value }, { 'hash': hash }] });
		}
		,
		remove_tags: function(tag){
			var self = this;
			var query = (tag.key && tag.value) ? { '$and': [{ 'key': tag.key }, { 'value': tag.value }] } : { 'key': tag.key };
			self.tags.removeWhere(query);
		}
		,
		remove_auto_tags: function(){
			this.tags.removeWhere({ 'auto': true });
		}
		,
		approve_tags: function(tag, hash){
			this.tags.findAndUpdate(
				function(obj){
					var value_cond = tag.value ? (tag.value == obj.value) : true;
					var file_cond = hash ? (hash == obj.hash) : true;
					return (obj.key == tag.key) && value_cond && file_cond;
				},
				function(obj){ obj.auto = false; return obj; }
			);
		}
		,
		rename_tags: function(tag1, tag2, hash){
			this.tags.findAndUpdate(
				function(obj){
					var value_cond = tag1.value ? (tag1.value == obj.value) : true;
					var file_cond = hash ? (hash == obj.hash) : true;
					return (obj.key == tag1.key) && value_cond && file_cond;
				},
				function(obj){
					obj.key = tag2.key || tag1.key;
					if (tag1.value && tag2.value){
						obj.value = tag2.value;
						obj.auto = false;
					}
					obj['key/value'] = obj.hash+'¹'+obj.key+'²'+obj.value;
					return obj;
				}
			);
		}
		,
		get_all_files: function(){
			var self = this;
			return self.files.data;
		}
		,
		remove_dead_files: function(){
			var self = this;
			var query = [];
			self.get_all_files().forEach(function(file, i){
				var subquery = { '$and': [{'path': file.path}, {'hash': file.hash}] };
				try {
					if (!FS.statSync(file.path).isFile()) {
						query.push(subquery);
					}
				} catch(e) {
					/* file not exists */
					query.push(subquery);
				}
			});
			if (query.length) {
				self.files.removeWhere({'$or': query});
			}
		}
		,
		get_verified_files: function(f){
			var self = this;
			var verified = [];
			var files = self.files.data;
			files.forEach(function(obj, i){
				if (
					self.tags.findOne({'$and': [{ 'hash': obj.hash }, { 'auto': false }]})
					&&
					!self.tags.findOne({'$and': [{ 'hash': obj.hash }, { 'auto': true }]})
				) {
					verified.push(obj);
				}
			});
			return verified;
		}
		,
		get_keys: function(verified_only){
			var mapper = function(obj, i, coll){
				var k = (typeof(verified_only)=='undefined' || verified_only == !obj.auto) ? obj.key : '';
				return k;
			};
			var reducer = function(array, values) {
				var distinct = [];
				array.forEach(function(key, i){
					if (key && distinct.indexOf(key) == -1) { distinct.push(key); }
				});
				return distinct.sort()
			}
			return this.tags ? this.tags.mapReduce(mapper, reducer) : [];
		}
		,
		get_values: function(key, verified_only){
			var distinct = [];
			var query = typeof(verified_only)=='undefined' ? {'key': key} : {'$and': [{ 'key': key }, { 'auto': !verified_only }]};
			var values = this.tags.find(query);
			values.forEach(function(obj, i){
				if (distinct.indexOf(obj.value) == -1) { distinct.push(obj.value); }
			});
			return distinct.sort();
		}
		,
		get_file_tags: function(hash, key){
			var query = key ? {'$and': [{ 'hash': hash }, { 'key': key }]} : { 'hash': hash };
			return this.tags.chain().find(query).compoundsort(['key','value']).data();
		}
		,
		has_tag: function(hash, key, value){
			var query = {'$and': [{ 'hash': hash }, { 'key': key }]};
			if (value) query['$and'].push({ 'value': value });
			return !!this.tags.findOne(query);
		}
		,
		get_files_by_tag: function(key, value){
			var self = this;
			if (!self.tags) return [];
			var hashes = self.tags.chain()
				.find({ '$and': [{ 'key': key }, { 'value': value }]})
				.mapReduce(function(obj){ return obj.hash; }, function(arr){ return arr; });
			var files = self.files.chain().where(function(obj) {
				return hashes.indexOf(obj.hash) != -1;
			}).simplesort('path').data();
			return files;
		}
		,
		get_tag_count: function(key, value){
			var query = { '$and': [{ 'key': key }, { 'hash': { '$ne': Database.NoFile } } ] };
			if (value) query['$and'].push({ 'value': value });
			return this.tags.count(query);
		}
		,
		get_untagged_files: function(key){
			var self = this;
			if (!self.files) return;
			var untagged = [];
			var files = self.files.data;
			files.forEach(function(obj, i){
				var query = key ? { '$and': [{ 'key': key }, { 'hash': obj.hash }] } : {'hash': obj.hash };
				if (!self.tags.findOne(query)) {
					untagged.push(obj);
				}
			});
			return untagged;
		}
		,
		remove_empty_tags: function(){
			var self = this;
			var query = { '$or': [{ 'key': '' }, { 'key': null }, { 'key': void 0 }, { 'value': '' }, { 'value': null }, { 'value': void 0 }] };
			self.tags.removeWhere(query);
		}
		,
		save_settings: function(settings){
			this.settings.update(settings);
		}
		,
		get_settings: function(){
			var obj = this.settings.get(1);
			if (!obj) obj = this.settings.insert({});
			return obj;
		}
	}
	

	var ViewDB = new Ractive({
		el: 'content',
		append: true,
		template: '#database-tpl',
		data: {
			N_files: [],
			files: [],
			untagged: [],
			verified: [],
			N_keys: 0,
			N_tags: 0
		}
	});
	ViewDB.update_stats = function(){
		this.set('N_files', Database.files.count() );
		this.set('untagged', Database.get_untagged_files('') );
		this.set('verified', Database.get_verified_files() );
		var N_tags = 0;
		var keys = Database.get_keys();
		keys.forEach(function(key, i){
			N_tags += Database.get_values(key).length;
		});
		this.set('N_keys', keys.length );
		this.set('N_tags', N_tags );
	};
	ViewDB.on({
		'save': function(){
			Database.db.saveDatabase();
		},
		'optimize': function(){
			Database.remove_dead_files();
			Database.remove_empty_tags();
			ViewDB.update_stats();
		},
	});
	
	var Processing = new Ractive({
		el: 'content',
		append: true,
		template: '#processing-tpl',
		data: {
			tags: 'manual',
			clear_old: true,
			keys: [],
			files: [],
			files_to_rename: []
		}
	});
	var Indexing = new Ractive({
		template: '#tag-index-tpl',
		data: {
			mask: '',
			keys: []
		}
	});
	
	var remove_folder_recursive = function(path) {
		try {
			if( FS.statSync(path).isDirectory() ) {
				FS.readdirSync(path).forEach(function(file,index){
					var curPath = path + "/" + file;
					if(FS.lstatSync(curPath).isDirectory()) { // recurse
						remove_folder_recursive(curPath);
					} else { // delete file
						FS.unlinkSync(curPath);
					}
				});
				FS.rmdirSync(path);
			}
		} catch(e) {}
	};
	var create_folder = function(dir){
		try { FS.mkdirSync(dir); }
		catch(e) { /* dir exists */ }
	};
	var get_timestamp = function(){
		var now = new Date();
		var dd = now.getDate();
		if (dd < 10) { dd = '0'+dd }
		var mm = now.getMonth()+1; //January is 0!
		if (mm < 10) { mm = '0'+mm }
		var yyyy = now.getFullYear();
		var hh = now.getHours();
		if (hh < 10) { hh = '0'+mm }
		var nn = now.getMinutes();
		if (nn < 10) { nn = '0'+nn }
		return dd+'.'+mm+'.'+yyyy+' '+hh+':'+nn;
	};
	var create_tag_index_file = function(filename, key, value, files){
		Indexing.set({
			tag: key+': '+value,
			files: files,
			date: get_timestamp()
		});
		FS.writeFileSync(filename, Indexing.toHTML());
	};
	Processing.append_to_mask = function(key){
		var mask = this.get('mask');
		mask += '<'+key+'>';
		this.set('mask', mask);
		this.event.original.preventDefault();
	};
	Processing.on({
		index: function(){
			var base_dir = './_index_';
			// clear old indexes
			if (this.get('clear_old')){
				remove_folder_recursive(base_dir);
			}
			create_folder(base_dir);
			// pick keys
			var f_verified = this.get('tags')=='manual' || undefined;
			var keys = Database.get_keys(f_verified);
			var tagset = this.get('tagset');
			if (tagset) {
				tagset = tagset.split(';').map(function(key){ return key.trim(); });
				keys = keys.filter(function(key){ return tagset.indexOf(key) != -1; });
			}
			// filter special
			if (!this.get('special_tags')){
				keys = keys.filter(function(key){ return !key.match(/^(#|@)/g); });
			}
			// generate indexes
			keys.forEach(function(key, i){
				var dirname = Sanitize_Filename(key,{replacement:'_'}) || '_k_'+i;
				create_folder(base_dir+'/'+dirname);
				
				var values = Database.get_values(key, f_verified);
				values.forEach(function(value, j){
					var files = Database.get_files_by_tag(key, value);
					if (files.length > 0) {
						var filename = Sanitize_Filename(value,{replacement:'_'}) || '_v_'+j;
						var path = base_dir+'/'+dirname+'/'+filename+'.html';
						create_tag_index_file(path, key, value, files);
					}
				});
			});
		},
		rename: function(){
			var mask = this.get('mask');
			var reg = new RegExp("\<(.*?)\>", "g");
			var mask_keys = mask.match(reg) || [];
			mask_keys = mask_keys.map(function(s){ return s.substr(1, s.length-2); });
			var files = this.get('files_to_rename');
			files.forEach(function(file, i){
				// var file = Database.get_file_by_path(filepath);
				// if (!file) return;
				var filetags = Database.get_file_tags(file.hash);
				var replacer = function (match, key, offset, string) {
					var filetag = filetags.find(function(tag){ return tag.key == key; });
					return filetag ? filetag.value : '';
				};
				var ext = file.name.match(/(.+?)(\.[^.]*$|$)/)[2];
				var new_name = mask.replace(reg, replacer);
				if (new_name && new_name != file.name) {
					Database.rename_file(file, new_name, ext);
				}
			});
		}
	});
	Processing.update_tagsets = function(){
		if (S.settings.tagsets) {
			this.set('tagsets', S.settings.tagsets);
		}
	};

	
	var EditableSelect = Ractive.extend({
		isolated: true,
		template:
			'<div class="es">'+
				'<input type="text" class="es-input form-control" value="{{value}}" autocomplete="off" lazy="300" on-input-keydown="on_key" on-input-keyup="filter" on-blur="hide_list" on-focus="show_list" />'+
				'<span class="es-clear {{value ? \'show\' : \'hide\'}} text-danger fa fa-times" on-click="clear" title="Очистить"></span>'+
				'<ul class="es-list dropdown-menu {{(list_visible && !no_matches) ? \'show\' : \'hide\'}}">'+
					'{{#list:i}}<li class="{{visible[i] ? \'show\' : \'hide\' }} {{active==i ? \'active\' : \'\' }}">'+
						'<a href="#" on-click="@this.select_li(this)" tabindex="-1">{{.}}</a>'+
					'</li>{{/list}}'+
				'</ul>'+
			'</div>',
		oninit: function(){
			var self = this;
			self.set({
				visible: [],
				active: -1,
				no_matches: true,
				list_visible: false
			});
			self.on({
				'clear': function(e){
					e.original.preventDefault();
					self.set('value', '');
				},
				'show_list': function(e){
					var $input = $(e.node);
					$input.closest('.es').find('.es-list')
					.css({
						top:   $input.position().top + $input.outerHeight() - 1,
						left:  $input.position().left,
						width: $input.outerWidth()
					})
					self.set('list_visible', true);
					self.fire('filter');
				},
				'hide_list': function(e){
					setTimeout(function(){
						self.set('list_visible', false);
						self.set('active', -1);
					}, 100);
				},
				'on_key': function(e){
					var self = this;
					switch (e.original.keyCode) {
						case 38: // Up
							e.original.preventDefault();
							var l = self.get('list.length');
							if (l==0) break;
							if (!self.get('list_visible')) { self.fire('show_list',e); };
							var a = self.get('active') || 0;
							while (a>0 && !self.get('visible.'+a)) { a--; }
							self.set('active', (a+l-1)%l);
							break;
						case 40: // Down
							e.original.preventDefault();
							var l = self.get('list.length');
							if (l==0) break;
							if (!self.get('list_visible')) { self.fire('show_list',e); break; };
							var a = self.get('active') >= 0 ? self.get('active') : -1;
							while (a<l && !self.get('visible.'+a)) { a++; }
							self.set('active', (a+1)%l);
							break;
						case 13: // Enter
							if (e.original.keyCode == 13) e.original.preventDefault();
							var a = self.get('active');
							if (self.get('visible.'+a)) {
								self.set('value', self.get('list.'+a));
							}
							// continue
						case 9:  // Tab
						case 27: // Esc
							self.fire('hide_list');
							break;
						default:
							self.fire('filter');
							break;
					}
				},
				'filter': function(){
					var self = this;
					var list = self.get('list');
					var search = (self.get('value') || '').toLowerCase().trim();
					var first = self.get('active') >=0 ? self.get('active') : -1;
					var no_matches = true;
					for (var i=0; i<list.length; i++){
						var found = (list[i] || '').toLowerCase().indexOf(search) >= 0;
						self.set('visible.'+i, found);
						no_matches = no_matches && !found;
						if (found && first==-1) { self.set('active', i); first = i; }
					}
					self.set('no_matches', no_matches);
				}
			});
			self.select_li = function(v){
				self.set('value', v);
				return false;
			};
		}
	});
	var TagsEditor = Ractive.extend({
		isolated: true,
		template:
			'<div class="te">'+
				'<input type="text" class="form-control input-xs input-ghost {{auto ? \'input-color_danger\' : \'\'}} {{!value ? \'input-ghost_empty\' : \'\'}}" value="{{value}}" lazy="300" autocomplete="off" on-keydown="on_key" on-focus="make_list" on-blur="@this.on_blur(1)" />'+
				'{{#if list.length}}<select class="te-list form-control input-xs" value="{{ready_value}}" on-focus="@this.on_focus(2)" on-blur="@this.on_blur(2)">'+
					'{{#if value}}<option value="{{value}}">{{value}}</option>{{/if}}'+
					'<option value=""></option>'+
					'{{#list}}{{#if this!=value}}<option value="{{.}}">{{.}}</option>{{/if}}{{/list}}'+
				'</select>{{/if}}'+
				'<select class="form-control input-xs input-ghost {{(tags.length > 1) ? \'show\' : \'hide\'}}" multiple value="{{selected}}" on-focus="@this.on_focus(3)" on-blur="@this.on_blur(3)">'+
					'{{#tags}}<option value="{{.value}}">{{.value}}</option>{{/tags}}'+
				'</select>'+
			'</div>',
		// necessary defaults
		data: {
			value: '',
			ready_value: '',
			selected: []
		},
		oninit: function(){
			var self = this;
			var Focused = {}, on_all_blurred = null;
			var tag_values_list = function(){
				var file = self.get('file');
				var key  = self.get('key');
				var ready_tags = file ? Database.get_file_tags(file.hash, key) : [];
				ready_tags = ready_tags.map(function(tag){ return tag.value; });
				var possible_tags = Database.get_values(key);
				possible_tags.filter(function(value){ return ready_tags.indexOf(value) == -1; });
				return possible_tags;
			};
			var select_input_text = function(){
				var input = self.find('input');
				if (input){
					input.select();
				}
			};
			var selected_to_input = function(val){
				var tag = self.get('tags').find(function(t){ return t.value === val; });
				self.set({
					value:   val,
					current: val,
					auto:    !!(tag && tag.auto)
				});
				// when input is focused, setting data doesn't affect input
				if (self.el && self.find('input')){
					self.find('input').value = val;
					self.updateModel('value');
				}
			};
			var NO_SELECTED = [];
			var update_tags = function(value_to_set){
				var file = self.get('file');
				var key  = self.get('key');
				var tags = file ? Database.get_file_tags(file.hash, key) : [];
				if (!value_to_set){
					value_to_set = tags.length ? tags[0].value : '';
				}
				var sel = value_to_set ? [ value_to_set ] : NO_SELECTED;
				self.set({
					tags: tags
				}).then(function(){
					self.set('selected', sel);
					if (Focused['1'] || Focused['2'] || Focused['3'] || on_all_blurred){
						self.set('list', tag_values_list());
					}
				});
			};
			var reset_nodes = function(){
				self.set({
					auto: false,
					value: '',
					current: '',
					selected: []
				});
				update_tags();
			};
			self.set('selected', []);
			reset_nodes();
			var save_tag = function(new_value){
				var old_value = self.get('current') || '';
				new_value = new_value || '';
				if (old_value == new_value) return;
				var file = self.get('file');
				var key  = self.get('key');
				var old_tag = {key: key, value: old_value};
				var new_tag = {key: key, value: new_value, auto: false};
				if (new_value) {
					var ready_tags = (self.get('tags') || []).map(function(tag){ return tag.value; });
					if (ready_tags.indexOf(new_value) != -1) return;
					if (old_value) {
						Database.rename_tags(old_tag, new_tag, file.hash);
					} else {
						Database.add_tag(file, new_tag);
					}
					update_tags(new_value);
				} else {
					if (old_value) {
						Database.remove_tag(file.hash, old_tag);
						update_tags();
					}
				}
			};
			self.observe({
				'file key': reset_nodes,
				'value': save_tag,
				'selected': function(selected, prev){
					if (selected === prev && selected[0] === prev[0]) return;
					selected_to_input(selected[0] || '');
				},
				'ready_value': function(selected, prev){
					if (selected===prev || selected==self.get('value')) return;
					self.set('value', selected);
				}
			});
			self.on({
				'on_key': function(e){
					var self = this;
					// Ctrl+Enter
					if (e.original.ctrlKey && e.original.keyCode == 13) {
						e.original.preventDefault();
						var new_tag = {key: self.get('key'), value: '?', auto: true};
						Database.add_tag(self.get('file'), new_tag);
						update_tags('?');
						select_input_text();
					}
					// Up or Down
					else if (e.original.keyCode == 38 || e.original.keyCode == 40) {
						e.original.preventDefault();
						$(e.node).closest('.te').find('.te-list').focus().trigger('mousedown');
					}
				},
				'make_list': function(e){
					self.set('list', tag_values_list());
					self.on_focus(1);
				}
			});
			self.on_focus = function(k){
				Focused[k+''] = true;
				if (on_all_blurred) { clearTimeout(on_all_blurred); on_all_blurred = null; }
			};
			self.on_blur = function(k){
				Focused[k+''] = false;
				if (Focused['1'] || Focused['2'] || Focused['3']){
					if (on_all_blurred) { clearTimeout(on_all_blurred); on_all_blurred = null; }
					return;
				}
				on_all_blurred = setTimeout(function(){ self.set('list', []); on_all_blurred = null; }, 400);
			};
		}
	});
	
	var Tagger = new Ractive({
		el: 'content',
		append: true,
		template: '#tagger-tpl',
		modifyArrays: true,
		data: {
			key: '',
			keys: [],
			value: '',
			values: [],
			untagged: [],
			tagged: [],
			tags_filter: 'all',
			all_tags_checked: false,
			a_key: '',
			a_keys: [],
			a_values: [],
			a_values_checked: [],
			files: [],
			tags_type: '',
			tags_view: 'table',
			files_checked: [],
			dir: function(file){
				return file ? file.path.substring(0, file.path.lastIndexOf(file.name)) : '';
			},
			path_esc: function(file){
				return file ? escape(file.path) : '';
			},
			tags: function(file, key){
				// for auto update on change
				var files = this.get('files');
				var keys = this.get('table_keys');
				return file ? Database.get_file_tags(file.hash, key) : [];
			},
			tags_list: function(file, key){
				// for auto update on change
				var files = this.get('files');
				var keys = this.get('table_keys');
				var empty = [{key: key, value: ''}];
				if (!file) return empty;
				var tags = Database.get_file_tags(file.hash, key);
				return tags.length ? tags : empty;
			},
			name_tpl: '',
			tagsets: [],
			tagset_title: '',
			table_keys: [],
			a_tag_count: function(key, value){
				// for auto update on change
				var a_values = this.get('a_values');
				return Database.get_tag_count(key, value);
			},
			a_tags_total: function(key){
				return Database.get_tag_count(key);
			},
			a_tag_percent: function(key, value){
				// for auto update on change
				var a_values = this.get('a_values');
				var count = this.get('a_tag_count')(key, value);
				var total = this.get('a_tags_total')(key);
				return total>0 ? Math.floor(count/total*100) : 0;
			}
		},
		computed: {
			name_tpl_ok: function(){ 
				var pattern = this.get('name_tpl');
				var reg;
				try {
					reg = new RegExp(pattern, 'i');
				} catch (e) {
					reg = null;
				}
				return !!reg;
			},
			no_auto_tags: function(){
				// for auto update on change
				var a_values = this.get('a_values');
				return Database.get_keys(false).length==0;
			}
		},
		components: {
			combotext: EditableSelect,
			tagsedit: TagsEditor
		}
	});
	Tagger.update_untagged_files = function(){
		return this.set('untagged', Database.get_untagged_files(this.get('key')) );
	};
	Tagger.update_tagged_files = function(){
		return this.set('tagged', Database.get_files_by_tag(this.get('key'), this.get('value')) );
	};
	Tagger.update_tags_keys = function(){
		return this.set('keys', Database.get_keys());
	};
	Tagger.update_tags_values = function(){
		var key = this.get('key');
		return this.set('values', key ? Database.get_values(key) : []);
	};
	Tagger.update_tags_keys_approving = function(){
		var filter = this.get('tags_filter');
		filter = (filter == 'all') ? undefined : (filter == 'manual');
		return this.set('a_keys', Database.get_keys(filter));
	};
	Tagger.update_tags_values_approving = function(){
		var key = this.get('a_key');
		var filter = this.get('tags_filter');
		filter = (filter == 'all') ? undefined : (filter == 'manual');
		return this.set('a_values', key ? Database.get_values(key, filter) : []);
	};
	Tagger.reset_tags_checked = function(){
		return this.set({
			all_tags_checked: false,
			a_values_checked: []
		});
	};
	Tagger.add_file_to_clipboard = function(file){
		var exists = this.get('files').find(function(f){ return f.hash==file.hash; });
		if (!exists){
			this.push('files', {hash: file.hash, name: file.name, path: file.path});
		}
	};
	Tagger.add_file_to_clipboard_by_hash = function(hash){
		var file = Database.get_file(hash);
		if (file) {
			Tagger.add_file_to_clipboard(file);
		}
	};
	Tagger.update_tagsets = function(){
		if (S.settings.tagsets) {
			this.set('tagsets', S.settings.tagsets);
		}
	};
	Tagger.observe({
		key: function(){
			this.set('value', '');
			this.update_tags_values();
			this.update_untagged_files();
		},
		value: function(){
			this.update_tagged_files();
		},
		tags_filter: function(){
			this.update_tags_keys_approving().then(function(){
				Tagger.update_tags_values_approving();
			});
		},
		all_tags_checked: function(v){
			var vals = this.get('a_values');
			var tags_checked = v ? vals.map(function(v){ return v; }) : [];
			this.set('a_values_checked', tags_checked);
		},
		a_key: function(){
			this.reset_tags_checked();
			this.update_tags_values_approving();
		},
		files: function(){
			this.update('dir');
			this.update('path_esc');
		}
	});
	
	var update_all_views = function(){
		ViewDB.update_stats();
		Tagger.update_tags_keys().then(function(){
			Tagger.update_tags_values();
		});
		Tagger.update_tags_keys_approving().then(function(){
			Tagger.update_tags_values_approving();
		});
		Tagger.update_untagged_files();
		Tagger.update_tagged_files();
		
		Processing.set('keys', Database.get_keys(true));
		Processing.set('files', Database.get_all_files().sort(function(a,b){return (a.name > b.name) ? 1 : ((b.name > a.name) ? -1 : 0);}));
	};
	
	Tagger.put_to_clipboard = function(files){
		var self = this;
		files.forEach(function(file, i){
			self.add_file_to_clipboard(file);
		});
	};
	Tagger.put_to_clipboard_tagged = function(key, value){
		var self = this;
		var files = Database.get_files_by_tag(key, value);
		files.forEach(function(file, i){
			self.add_file_to_clipboard(file);
		});
	};
	Tagger.set_tag = function(key, value){
		var self = this;
		self.set('key', key).then(function(){  // wait for keys list loading before setting tag value
			self.set('value', value);
		});
	};
	Tagger.apply_to_files = function(key, value, hashes){
		hashes.forEach(function(hash){
			Database.add_tag({hash: hash}, {key: key, value: value, auto: false}, function(){
				update_all_views();
				Tagger.update('files');
			});
		});
	};
	Tagger.remove_from_files = function(key, value, hashes){
		hashes.forEach(function(hash){
			Database.remove_tag(hash, {key: key, value: value});
			update_all_views();
			Tagger.update('files');
		});
	};
	Tagger.check_files = function(key, value){
		var files_checked = [];
		var files = this.get('files');
		files.forEach(function(file, i){
			if (Database.has_tag(file.hash, key, value)) files_checked.push(file.hash);
		});
		this.set('files_checked', files_checked);
	};
	Tagger.on({
		check_all_files: function(){
			var files = this.get('files');
			var files_checked = files.map(function(f){ return f.hash; });
			this.set('files_checked', files_checked);
		},
		inverse_checked_files: function(){
			var new_checked = [];
			var checked_files_hashes = this.get('files_checked');
			var files = this.get('files');
			files.forEach(function(file, i){
				if (checked_files_hashes.indexOf(file.hash) == -1) new_checked.push(file.hash);
			});
			this.set('files_checked', new_checked);
		},
		remove_checked_files: function(){
			var checked_files_hashes = this.get('files_checked');
			var new_files = [];
			var files = this.get('files');
			files.forEach(function(file, i){
				if (checked_files_hashes.indexOf(file.hash) == -1) new_files.push(file);
			});
			this.set({
				files: new_files,
				files_checked: []
			});
		},
		clear_clipboard: function(){
			this.set({
				files: [],
				files_checked: []
			});
		}
	});
	Tagger.rename_key = function(key){
		var new_key = prompt('Новое название ключа «'+key+'»', key);
		if (new_key) {
			Database.rename_tags({key: key}, {key: new_key});
			this.update_tags_values_approving();
		}
		update_all_views();
		Tagger.update('files');
		this.event.original.preventDefault();
	};
	Tagger.filter_tags = function(filter){
		this.set('tags_filter', filter);
		this.event.original.preventDefault();
	};
	Tagger.remove_key = function(key){
		Database.remove_tags({key: key});
		update_all_views();
		Tagger.update('files');
		this.event.original.preventDefault();
	};
	Tagger.approve_tag_value = function(key, value, files){
		var tag = {key: key, value: value};
		if (files && files.length) {
			files.forEach(function(hash){
				Database.approve_tags(tag, hash);
			});
		} else {
			Database.approve_tags(tag);
		}
		update_all_views();
		Tagger.update('files');
		this.reset_tags_checked();
	};
	Tagger.remove_tag_value = function(key, value){
		Database.remove_tags({key: key, value: value});
		update_all_views();
		Tagger.update('files');
		this.reset_tags_checked();
	};
	Tagger.edit_tag_key = function(key, value, files){
		var new_key = prompt('Новый ключ для тега «'+value+'»', key);
		if (new_key) {
			var tag1 = {key: key, value: value};
			var tag2 = {key: new_key, value: value};
			if (files && files.length) {
				files.forEach(function(hash){
					Database.rename_tags(tag1, tag2, hash);
				});
			} else {
				Database.rename_tags(tag1, tag2);
			}
			this.update_tags_keys_approving().then(function(){
				update_all_views();
				Tagger.update('files');
				Tagger.reset_tags_checked();
			});
		}
	};
	Tagger.edit_tag_value = function(key, value, files){
		var new_value = prompt('Новое значение для тега «'+key+'»', value);
		if (new_value) {
			var tag1 = {key: key, value: value};
			var tag2 = {key: key, value: new_value};
			if (files && files.length) {
				files.forEach(function(hash){
					Database.rename_tags(tag1, tag2, hash);
				});
			} else {
				Database.rename_tags(tag1, tag2);
			}
			this.update_tags_values_approving();
			this.reset_tags_checked();
		}
	};
	Tagger.approve_checked_tags = function(){
		var key = this.get('a_key');
		var values = this.get('a_values_checked');
		values.forEach(function(value, i){
			Database.approve_tags({key: key, value: value});
		});
		this.update_tags_values_approving();
		this.reset_tags_checked();
	};
	Tagger.remove_checked_tags = function(){
		var key = this.get('a_key');
		var values = this.get('a_values_checked');
		values.forEach(function(value, i){
			Database.remove_tags({key: key, value: value});
		});
		this.set('all_tags_checked', false);
		this.update_tags_keys_approving().then(function(){
			Tagger.update_tags_values_approving();
			Tagger.reset_tags_checked();
		});
	};
	Tagger.rename_checked_tags_values = function(){
		var key = this.get('a_key');
		var new_key = prompt('Новое название ключа для отмеченных тегов', key);
		if (new_key) {
			var values = this.get('a_values_checked');
			values.forEach(function(value, i){
				Database.rename_tags({key: key, value: value}, {key: new_key, value: value});
			});
			this.set('all_tags_checked', false);
			this.update_tags_keys_approving().then(function(){
				Tagger.update_tags_values_approving();
				Tagger.reset_tags_checked();
			});
		}
	};
	Tagger.clear_auto_tags = function(){
		Database.remove_auto_tags();
		update_all_views();
		Tagger.update('files');
	};
	Tagger.regexp_tags = function(pattern){
		this.set('name_tpl', pattern);
		this.event.original.preventDefault();
	};
	Tagger.parse_tags = function(pattern){
		var reg;
		try {
			reg = new RegExp(pattern, 'i');
		} catch(e) {
			reg = new RegExp('', 'i');
		}
		var files = this.get('files');
		var checked_files_hashes = this.get('files_checked');
		files.forEach(function(file, i){
			if (checked_files_hashes.indexOf(file.hash) == -1) return;
			var clearname = file.name.match(/(.+?)(\.[^.]*$|$)/)[1];
			var match = clearname.match(reg);
			if (match && match.length > 1){
				match.forEach(function(m, i){
					if (i==0) return;
					Database.add_tag({hash: file.hash}, {key: '#AUTO#'+i, value: m, auto: true}, function(){
						update_all_views();
						Tagger.update('files');
					});
				});
			}
		});
	};
	Tagger.exec_file = function(path){
		GUI.Shell.openItem(path);
		return false;
	};
	Tagger.on({
		'scroll-db-table': function(e){
			var scroll_body = $(e.node);
			var db_table = scroll_body.closest('.db-table');
			// scroll header
			var pos_x = $(e.node).scrollLeft();
			db_table.find('.db-table__scroll-header').scrollLeft( pos_x );
			// scroll column
			var pos_y = scroll_body.scrollTop();
			if (db_table.data('scrollTop') != pos_y){
				db_table.data('scrollTop', pos_y);
				db_table.find('.db-table__left-body-inner').scrollTop( pos_y );
			}
			db_table.find('.db-table__left-body').toggleClass('db-table__left-body_fixed', pos_x > 0);
		},
		'scroll-db-table-fixed-column': function(e){
			var scroll_column = $(e.node);
			var db_table = scroll_column.closest('.db-table');
			// scroll table body
			var pos_y = scroll_column.scrollTop();
			if (db_table.data('scrollTop') != pos_y){
				db_table.data('scrollTop', pos_y);
				db_table.find('.db-table__scroll-body').scrollTop( pos_y );
			}
		}
	});
	Tagger.set_table_keys = function(keys, title){
		var table_keys = !keys ? this.get('keys') : keys.split(';').map(function(key){ return key.trim(); });
		this.set('table_keys', table_keys);
		this.set('tagset_title', title);
		this.event.original.preventDefault();
	};
	var save_file_tag_fn = function(e, file, key, old_value){
		Tagger.update_tags_keys().then(function(){
			Tagger.update_tags_values();
		});
		Tagger.update_tags_keys_approving().then(function(){
			Tagger.update_tags_values_approving();
		});
	};
	
	
	$(window).on('dragover drop', function(e){ e.preventDefault(); return false; });
	$('.dropzone')
	.on('dragover', function(e){
		$(this).removeClass('alert-warning').addClass('alert-success');
		return false;
	}).on('dragleave', function(e){
		$(this).removeClass('alert-success').addClass('alert-warning');
		return false;
	}).on('drop', function(e){
		e.preventDefault();
		$(this).removeClass('alert-success').addClass('alert-warning');
		return true;
	});
	var all_dropped_files = function(items, callback){
		// filter by regexp
		var filter;
		if (S.settings.filefilter) {
			try {
				filter = new RegExp(S.settings.filefilter, 'i');
			} catch(e) {
				filter = null;
			}
		} else {
			filter = null;
		}
		
		var files_dropped = [];
		var push_file = function(file){
			// TODO: make low priority queue, esp. if total size > 10M
			var m = file.name.match(filter);
			if (filter && (!m || !m[0])){ return; }
			callback(file);
			// files_dropped.push(file);
		};
		var readFileTree = function(item) {
			if (item.isFile) {
				item.file(push_file);
			} 
			else if (item.isDirectory) {
				var dirReader = item.createReader()
				dirReader.readEntries(function(entries) {
					for (var i = 0; i < entries.length; i++){
						readFileTree(entries[i]);
					}
				});
			}
		};
		if (items) {
			for (var i = 0; i < items.length; i++){
				var item = items[i];
				var entry = null;
				if (item.getAsEntry) {
					entry = item.getAsEntry();
				}
				else if (item.webkitGetAsEntry) {
					entry = item.webkitGetAsEntry();
				}
				if (entry) {
					if (entry.isFile) {
						entry.file(push_file);
					}
					else if (entry.isDirectory) {
						readFileTree(entry);
					}
				}
			}
		}
		// TODO: make low priority queue, esp. if total size > 10M
		/* for (var i=0; i<files_dropped.length; i++){
			// total_size += files_dropped[i].size;
			callback(files_dropped[i]);
			console.log(files_dropped[i].name);
		}
		*/
	};
	$('#dropzone-tags').on('drop', function(e){
		all_dropped_files(e.originalEvent.dataTransfer.items, function(file){
			var key = Tagger.get('key');
			var value = Tagger.get('value');
			if (key && value) {
				var tag = Database.add_tag(file, {key: key, value: value, auto: false}, update_all_views);
				Tagger.add_file_to_clipboard_by_hash(tag.hash);
			} else {
				var hash = Database.add_file(file, update_all_views);
				Tagger.add_file_to_clipboard_by_hash(hash);
			}
		});
		/* var files = e.originalEvent.dataTransfer.files; */
		return false;
	});
	
	var Settings = new Ractive({
		el: 'content',
		append: true,
		template: '#settings-tpl',
		modifyArrays: true,
		data: {
			root_folder: '',
			read_metadata: false,
			filefilter: '',
			tagsets: [],
			pretags: []
		},
		computed: {
			filefilter_ok: function(){
				var pattern = this.get('filefilter');
				var reg;
				try {
					reg = new RegExp(pattern, 'i');
				} catch (e) {
					reg = null;
				}
				return !!reg;
			}
		}
	});
	Settings.start_observe = function(){
		this.observe({
			root_folder: function(path){
				S.settings.root_folder = path;
				Database.save_settings(S.settings);
			},
			read_metadata: function(f){
				S.settings.read_metadata = f;
				Database.save_settings(S.settings);
			},
			filefilter: function(filter){
				S.settings.filefilter = filter;
				Database.save_settings(S.settings);
			}
		});
	};
	Settings.on({
		'select-folder': function(e){
			var self = this;
			chrome.fileSystem.chooseEntry({type: 'openDirectory'}, function(dir){
				chrome.fileSystem.getDisplayPath(dir, function(path){
					self.set('root_folder', path);
				});
			});
		}
	});
	Settings.regexp_filter = function(pattern){
		this.set('filefilter', pattern);
		this.event.original.preventDefault();
	};
	Settings.edit_tagset = function(tagset){
		this.set({
			current_tagset: tagset.title,
			tagset_title:   tagset.title,
			tagset_keys:    tagset.keys
		});
	};
	Settings.save_tagset = function(title, remove){
		if (!S.settings.tagsets) S.settings.tagsets = [];
		if (title) {
			S.settings.tagsets = S.settings.tagsets.filter(function(ts,i){ return ts.title !== title });
		}
		if (!remove) {
			S.settings.tagsets.push({
				title: this.get('tagset_title'),
				keys:  this.get('tagset_keys')
			});
			S.settings.tagsets.sort(function(a,b){return (a.title > b.title) ? 1 : ((b.title > a.title) ? -1 : 0);});
		}
		Database.save_settings(S.settings);
		this.set({
			tagsets: S.settings.tagsets,
			current_tagset: '',
			tagset_title:   '',
			tagset_keys:    ''
		});
		Tagger.update_tagsets();
		Processing.update_tagsets();
	};
	Settings.save_pretag = function(){
		var tag = {
			key:   this.get('pretag_key'),
			value: this.get('pretag_value'),
			auto:  false
		};
		Database.add_tag({hash: Database.NoFile}, tag);
		this.push('pretags', tag);
	},
	Settings.remove_pretag = function(tag, i){
		Database.remove_tag(Database.NoFile, tag);
		this.splice('pretags', i, 1);
	};
	Settings.load_from_DB = function(){
		S.settings = Database.get_settings();
		S.settings.folder_selected = S.settings.folder_selected || '';
		S.settings.read_metadata   = S.settings.read_metadata || false;
		S.settings.filefilter      = S.settings.filefilter || '';
		S.settings.tagsets         = (S.settings.tagsets || []).map(function(t){ return {title: t.title, keys: t.keys}; });   // ractive hangs on reading array from pure DB data
		this.set(S.settings).then(function(){
			Settings.start_observe();
			Tagger.update_tagsets();
			Processing.update_tagsets();
		});
		this.set('pretags', Database.get_file_tags(Database.NoFile));
	};
	
	Database.init().then(function(){
		Settings.load_from_DB();
		update_all_views();
		setInterval(update_all_views, S.interval.update_view);
	});
});
