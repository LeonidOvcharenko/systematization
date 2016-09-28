$(function(){
	var Database;
	
	var EXIF = require('exif-reader');
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
					this.from_jpeg(hash, data);
					format = 'JPEG';
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
				Database.add_tag({hash: hash}, {key: 'FORMAT', value: format, auto: false});
			}
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
		from_jpeg: function(hash, data){
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

	var FS     = require('fs');
	var Crypto = require('crypto');
	var Loki   = require('lokijs');
	Database = {
		init: function(callback){
			var self = this;
			var dfrd = $.Deferred();
			var db_loader = function(){
				self.files = self.db.getCollection('files') || self.db.addCollection('files', {exact: ['hash', 'path'], unique: ['hash']});
				self.tags  = self.db.getCollection('tags') || self.db.addCollection('tags', {indices: ['key'], unique: ['key/value']});
				dfrd.resolve();
			};
			self.db = new Loki('files.json', {
				autoload: true, autoloadCallback: db_loader,
				autosave: true, autosaveInterval: 5000
			});
			return dfrd.promise();
		}
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
				Preprocessor.auto_tags(file.path, hash, data);
			} catch(e){}
			return hash;
		}
		,
		get_hash_from_db: function(filepath){
			return self.files.findOne({'path': { '$eq' : filepath }});
		}
		,
		add_tag: function(file, tag, callback){
			var self = this;
			var hash = file.hash || self.add_file(file, callback);  // just in case
			tag.value = tag.value.trim();
			if (!tag.value) return;
			var inserted = self.tags.insert({
				hash:  hash,
				key:   tag.key,
				value: tag.value,
				'key/value': hash+'¹'+tag.key+'²'+tag.value,
				auto:  !!tag.auto
			});
			if (inserted && callback) { callback(); }
		}
		,
		add_tags: function(file, tags, auto, callback){
			var self = this;
			var hash = file.hash || self.add_file(file, callback);  // just in case
			for (var key in tags){
				var value = (tags[key]+'').trim();  // convert numbers, objects and arrays to strings
				if (!value) continue;
				var inserted = self.tags.insert({
					hash:  hash,
					key:   key,
					value: value,
					'key/value': hash+'¹'+key+'²'+value,
					auto:  !!auto
				});
				if (inserted && callback) { callback(); }
			}
		}
		,
		remove_tag: function(hash, tag){
			var self = this;
			self.tags.removeWhere({ '$and': [{ 'key': tag.key }, { 'value': tag.value }, { 'hash': hash }] });
		}
		,
		get_untagged_files: function(){
			var self = this;
			var untagged = [];
			var files = self.files.data;
			files.forEach(function(obj, i){
				if (!self.tags.findOne({'hash': { '$eq': obj.hash }})) {
					untagged.push(obj);
				}
			});
			return untagged;
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
				var k = obj.key;
				if (verified_only) { k = !obj.auto ? obj.key : ''; }
				return k;
			};
			var reducer = function(array, values) {
				var distinct = [];
				array.forEach(function(key, i){
					if (key && distinct.indexOf(key) == -1) { distinct.push(key); }
				});
				return distinct.sort()
			}
			return this.tags.mapReduce(mapper, reducer);
		}
		,
		get_values: function(key, verified_only){
			var distinct = [];
			var query = verified_only ? {'$and': [{ 'key': key }, { 'auto': false }]} : {'key': key};
			var values = this.tags.find(query);
			values.forEach(function(obj, i){
				if (distinct.indexOf(obj.value) == -1) { distinct.push(obj.value); }
			});
			return distinct.sort();
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
	}
	

	var ViewDB = new Ractive({
		el: 'database',
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
		this.set('untagged', Database.get_untagged_files() );
		this.set('verified', Database.get_verified_files() );
	};
	
	var Processing = new Ractive({
		el: 'processing',
		template: '#processing-tpl',
		data: {
		}
	});
	var Indexing = new Ractive({
		template: '#tag-index-tpl',
		data: {
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
	var Sanitize_Filename = require("sanitize-filename");
	Processing.on({
		index: function(){
			var base_dir = './_index_';
			create_folder(base_dir);
			var f_verified = this.get('tags')=='manual';
			var keys = Database.get_keys(f_verified);
			keys.forEach(function(key, i){
				var dirname = Sanitize_Filename(key) || '_k_'+i;
				create_folder(base_dir+'/'+dirname);
				
				var values = Database.get_values(key, f_verified);
				values.forEach(function(value, j){
					var files = Database.get_files_by_tag(key, value);
					if (files.length > 0) {
						var filename = Sanitize_Filename(value) || '_v_'+j;
						var path = base_dir+'/'+dirname+'/'+filename+'.html';
						create_tag_index_file(path, key, value, files);
					}
				});
			});
		},
		rename: function(){ /* TODO */ }
	});


	
	$('#save_db').on('click', function(){ Database.db.saveDatabase(); });
	
	var EditableSelect = Ractive.extend({
		isolated: true,
		template:
			'<div class="es">'+
				'<input type="text" class="es-input form-control" value="{{value}}" autocomplete="off" on-input-keydown="on_key" on-input-keyup="filter" on-blur="hide_list" on-focus="show_list" />'+
				'<span class="es-clear {{value ? \'show\' : \'hide\'}} text-danger" on-click="clear" title="Очистить">×</span>'+
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
						case 37: // Left
						case 38: // Up
							e.original.preventDefault();
							var l = self.get('list.length');
							if (l==0) break;
							if (!self.get('list_visible')) { self.fire('show_list',e); };
							var a = self.get('active') || 0;
							while (a>0 && !self.get('visible.'+a)) { a--; }
							self.set('active', (a+l-1)%l);
							break;
						case 39: // Right
						case 40: // Down
							e.original.preventDefault();
							var l = self.get('list.length');
							if (l==0) break;
							if (!self.get('list_visible')) { self.fire('show_list',e); break; };
							var a = self.get('active') >= 0 ? self.get('active') : -1;
							while (a<l && !self.get('visible.'+a)) { a++; }
							self.set('active', (a+1)%l);
							break;
						case 9:  // Tab
						case 13: // Enter
							if (e.original.keyCode == 13) e.original.preventDefault();
							var a = self.get('active');
							if (self.get('visible.'+a)) {
								self.set('value', self.get('list.'+a));
							}
							// continue
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
					var search = self.get('value').toLowerCase().trim();
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
	
	var Tagger = new Ractive({
		el: 'tagger',
		template: '#tagger-tpl',
		data: {
			key: '',
			keys: [],
			value: '',
			values: [],
			untagged: [],
			files_to_tag: [],
			tagged: [],
			files_with_tag: []
		},
		components: {
			myselect: EditableSelect
		}
	});
	Tagger.update_untagged_files = function(){
		return this.set('untagged', Database.get_untagged_files() );
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
	Tagger.observe({
		key: function(){
			this.set('value', '');
			this.update_tags_values();
		},
		value: function(){
			this.update_tagged_files();
		},
		files_to_tag: function(){
			
		}
	});
	
	var update_all_views = function(){
		ViewDB.update_stats();
		Tagger.update_tags_keys().then(function(){
			Tagger.update_tags_values();
		});
		Tagger.update_untagged_files();
		Tagger.update_tagged_files();
	};
	setInterval(update_all_views, 10000);
	
	Tagger.on({
		clear_to_tag: function(){ this.set('files_to_tag', []); },
		clear_with_tag: function(){ this.set('files_with_tag', []); },
		apply_to_files: function(){
			var files = this.get('files_to_tag');
			for (var i=0; i<files.length; i++){
				Database.add_tag({hash: files[i]}, {key: Tagger.get('key'), value: Tagger.get('value'), auto: false}, function(){
					update_all_views();
				});
			}
			this.set('files_to_tag', []);
		},
		remove_from_files: function(){
			var files = this.get('files_with_tag');
			for (var i=0; i<files.length; i++){
				Database.remove_tag(files[i], {key: Tagger.get('key'), value: Tagger.get('value')});
				update_all_views();
			}
			this.set('files_with_tag', []);
		}
	});
	
	
	
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
		var files_dropped = [];
		var push_file = function(file){
			// TODO: make low priority queue, esp. if total size > 10M
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
	$('#dropzone-db').on('drop', function(e){
		all_dropped_files(e.originalEvent.dataTransfer.items, function(file){
			Database.add_file(file, function(){
				update_all_views();
			});
		});
		return false;
	});
	$('#dropzone-tags').on('drop', function(e){
		all_dropped_files(e.originalEvent.dataTransfer.items, function(file){
			Database.add_tag(file, {key: Tagger.get('key'), value: Tagger.get('value'), auto: false}, function(){
				update_all_views();
			});
		});
		/* var files = e.originalEvent.dataTransfer.files; */
		return false;
	});
	
	Database.init().then(function(){
		update_all_views();
	});
});
