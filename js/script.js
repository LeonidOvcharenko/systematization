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
				self.files     = self.db.getCollection('files')    || self.db.addCollection('files', {exact: ['hash', 'path'], unique: ['hash']});
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
		rename_file: function(file, new_name){
			new_name = Sanitize_Filename(new_name,{replacement:'_'});
			var new_path = file.path.substring(0, file.path.lastIndexOf(file.name))+new_name;
			try {
				if (FS.statSync(new_path).isFile()) return;  // prevent file overwriting
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
				var value = (tags[key]+'').trim();  // convert numbers, objects and arrays to strings
				if (!value || value.toString() == "[object Object]") continue;
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
			verified: []
		}
	});
	ViewDB.update_stats = function(){
		this.set('N_files', Database.files.count() );
		this.set('untagged', Database.get_untagged_files('') );
		this.set('verified', Database.get_verified_files() );
	};
	ViewDB.on({
		'save': function(){
			Database.db.saveDatabase();
		},
		'optimize': function(){
			Database.remove_empty_tags();
		},
	});
	
	var Processing = new Ractive({
		el: 'content',
		append: true,
		template: '#processing-tpl',
		data: {
			tags: 'manual'
		}
	});
	var Indexing = new Ractive({
		template: '#tag-index-tpl',
		data: {
			mask: '',
			keys: []
		}
	});
	
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
	Processing.on({
		index: function(){
			var base_dir = './_index_';
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
		append_to_mask: function(e, key){
			e.original.preventDefault();
			var mask = this.get('mask');
			mask += '<'+key+'>';
			this.set('mask', mask);
		},
		rename: function(){
			var mask = this.get('mask');
			var reg = new RegExp("\<(.*?)\>", "g");
			var mask_keys = mask.match(reg) || [];
			mask_keys = mask_keys.map(function(s){ return s.substr(1, s.length-2); });
			var files = Database.get_all_files();
			files.forEach(function(file, i){
				var filetags = Database.get_file_tags(file.hash);
				var replacer = function (match, key, offset, string) {
					var filetag = filetags.find(function(tag){ return tag.key == key; });
					return filetag ? filetag.value : '';
				};
				var ext = file.name.match(/(.+?)(\.[^.]*$|$)/)[2];
				var new_name = mask.replace(reg, replacer)+ext;
				if (new_name && new_name != file.name) {
					Database.rename_file(file, new_name);
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
						'<a href="#" on-click="select_li" tabindex="-1">{{.}}</a>'+
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
				'select_li': function(e){
					e.original.preventDefault();
					self.set('value', e.context);
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
		}
	});
	var TagsEditor = Ractive.extend({
		isolated: true,
		template:
			'<div class="te">'+
				'<input type="text" class="form-control input-xs input-ghost {{auto ? \'input-color_danger\' : \'\'}} {{!value ? \'input-ghost_empty\' : \'\'}}" value="{{value}}" lazy="300" autocomplete="off" on-keydown="on_key" />'+
				'<select class="form-control input-xs input-ghost {{(tags.length > 1) ? \'show\' : \'hide\'}}" multiple value="{{selected}}">'+
					'{{#tags}}<option value="{{.value}}">{{.value}}</option>{{/tags}}'+
				'</select>'+
			'</div>',
		oninit: function(){
			var self = this;
			var select_input_text = function(){
				var input = self.find('input');
				if (input){
					input.select();
				}
			};
			var selected_to_input = function(val){
				var tag = self.get('tags').find(function(t){ return t.value === val; });
				self.set({
					current: val,
					value:   val,
					auto:    !!(tag && tag.auto)
				});
				// when input is focused, setting data doesn't affect input
				var input = self.find('input');
				if (input){
					input.value = val;
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
				}
			});
		}
	});
	
	var Tagger = new Ractive({
		el: 'content',
		append: true,
		template: '#tagger-tpl',
		data: {
			key: '',
			keys: [],
			value: '',
			values: [],
			untagged: [],
			tagged: [],
			tags_filter: 'all',
			all_tags_checked: false,
			tags_checked: [],
			a_key: '',
			a_keys: [],
			a_values: [],
			a_values_checked: [],
			files: [],
			tags_type: '',
			tags_view: 'table',
			files_checked: [],
			checked_files_hashes: [],
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
			table_keys: []
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
			tags_checked: []
		});
	};
	Tagger.add_file_to_clipboard = function(file){
		var hashes = this.get('files').map(function(f){ return f.hash; });
		if (hashes.indexOf(file.hash) == -1){
			this.push('files', file);
		}
	};
	Tagger.add_file_to_clipboard_by_hash = function(hash){
		var file = Database.get_file(hash);
		Tagger.add_file_to_clipboard(file);
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
			var tags_checked = [];
			var l = this.get('a_values.length');
			for (var i=0;i<l;i++){ tags_checked.push(!!v); }
			this.set('tags_checked', tags_checked);
		},
		a_key: function(){
			this.reset_tags_checked();
			this.update_tags_values_approving();
		},
		tags_checked: function(checks){
			var values_checked = [];
			var values = this.get('a_values');
			checks.forEach(function(v, i){
				if (v) values_checked.push(values[i]);
			});
			this.set('a_values_checked', values_checked);
		},
		files_checked: function(checks){
			var files_checked = [];
			var files = this.get('files');
			checks.forEach(function(v, i){
				if (v) files_checked.push(files[i].hash);
			});
			this.set('checked_files_hashes', files_checked);
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
	};
	
	Tagger.on({
		put_to_clipboard: function(e, files){
			var self = this;
			files.forEach(function(file, i){
				self.add_file_to_clipboard(file);
			});
		},
		put_to_clipboard_tagged: function(e, key, value){
			var self = this;
			var files = Database.get_files_by_tag(key, value);
			files.forEach(function(file, i){
				self.add_file_to_clipboard(file);
			});
		},
		set_tag: function(e, key, value){
			var self = this;
			self.set('key', key).then(function(){  // wait for keys list loading before setting tag value
				self.set('value', value);
			});
		},
		apply_to_files: function(e, key, value, hashes){
			hashes.forEach(function(hash){
				Database.add_tag({hash: hash}, {key: key, value: value, auto: false}, function(){
					update_all_views();
					Tagger.update('files');
				});
			});
		},
		remove_from_files: function(e, key, value, hashes){
			hashes.forEach(function(hash){
				Database.remove_tag(hash, {key: key, value: value});
				update_all_views();
				Tagger.update('files');
			});
		},
		check_files: function(e, key, value){
			var files_checked = [];
			var files = this.get('files');
			files.forEach(function(file, i){
				if (Database.has_tag(file.hash, key, value)) files_checked[i] = true;
			});
			this.set('files_checked', files_checked);
		},
		check_all_files: function(){
			var files_checked = [];
			var l = this.get('files.length');
			for (var i=0;i<l;i++){ files_checked.push(true); }
			this.set('files_checked', files_checked);
		},
		inverse_checked_files: function(){
			var new_checked = [];
			var checked_files_hashes = this.get('checked_files_hashes');
			var files = this.get('files');
			files.forEach(function(file, i){
				new_checked.push(checked_files_hashes.indexOf(file.hash) == -1);
			});
			this.set('files_checked', new_checked);
		},
		remove_checked_files: function(){
			var checked_files_hashes = this.get('checked_files_hashes');
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
		},
		rename_key: function(e, key){
			e.original.preventDefault();
			var new_key = prompt('Новое название ключа «'+key+'»', key);
			if (new_key) {
				Database.rename_tags({key: key}, {key: new_key});
				this.update_tags_values_approving();
			}
			update_all_views();
			Tagger.update('files');
		},
		filter_tags: function(e, filter){
			e.original.preventDefault();
			this.set('tags_filter', filter);
		},
		remove_key: function(e, key){
			e.original.preventDefault();
			Database.remove_tags({key: key});
			update_all_views();
			Tagger.update('files');
		},
		approve_tag_value: function(e, key, value, files){
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
		},
		remove_tag_value: function(e, key, value){
			Database.remove_tags({key: key, value: value});
			update_all_views();
			Tagger.update('files');
			this.reset_tags_checked();
		},
		edit_tag_key: function(e, key, value, files){
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
		},
		edit_tag_value: function(e, key, value, files){
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
		},
		approve_checked_tags: function(){
			var key = this.get('a_key');
			var values = this.get('a_values_checked');
			values.forEach(function(value, i){
				Database.approve_tags({key: key, value: value});
			});
			this.update_tags_values_approving();
			this.reset_tags_checked();
		},
		remove_checked_tags: function(){
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
		},
		rename_checked_tags_values: function(){
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
				});
			}
		},
		clear_auto_tags: function(){
			Database.remove_auto_tags();
			update_all_views();
			Tagger.update('files');
		},
		regexp_tags: function(e, pattern){
			e.original.preventDefault();
			this.set('name_tpl', pattern);
		},
		parse_tags: function(e, pattern){
			var reg;
			try {
				reg = new RegExp(pattern, 'i');
			} catch(e) {
				reg = new RegExp('', 'i');
			}
			var files = this.get('files');
			var checked_files_hashes = this.get('checked_files_hashes');
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
		},
		exec_file: function(e, path){
			e.original.preventDefault();
			GUI.Shell.openItem(path);
		},
		
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
		},
		set_table_keys: function(e, keys, title){
			e.original.preventDefault();
			var table_keys = !keys ? this.get('keys') : keys.split(';').map(function(key){ return key.trim(); });
			this.set('table_keys', table_keys);
			this.set('tagset_title', title);
		}
	});
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
		data: {
			folder_selected: '',
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
		},
		regexp_filter: function(e, pattern){
			e.original.preventDefault();
			this.set('filefilter', pattern);
		},
		'edit-tagset': function(e, tagset){
			this.set({
				current_tagset: tagset.title,
				tagset_title:   tagset.title,
				tagset_keys:    tagset.keys
			});
		},
		'save-tagset': function(e, title, remove){
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
		},
		'save-pretag': function(){
			var tag = {
				key:   this.get('pretag_key'),
				value: this.get('pretag_value'),
				auto:  false
			};
			Database.add_tag({hash: Database.NoFile}, tag);
			this.push('pretags', tag);
		},
		'remove-pretag': function(e, tag, i){
			Database.remove_tag(Database.NoFile, tag);
			this.splice('pretags', i, 1);
		}
	});
	Settings.load_from_DB = function(){
		S.settings = Database.get_settings();
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
