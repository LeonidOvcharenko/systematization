$(function(){
	var FS     = require('fs');
	var Crypto = require('crypto');
	var Loki   = require('lokijs');
	var Database = {
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
		add_file: function(filepath, callback){
			var self = this;
			FS.readFile(filepath, function(err, data){
				var hash = self.hash_file(data);
				var inserted = self.files.insert({
					path: filepath,
					hash: hash
				});
				if (inserted && callback) { callback(); }
			});
		}
		,
		get_hash_from_db: function(filepath){
			return self.files.findOne({'path': { '$eq' : filepath }});
		}
		,
		add_tag: function(filepath, tag, callback){
			var self = this;
			self.add_file(filepath, callback);  // just in case
			FS.readFile(filepath, function(err, data){
				var hash = self.hash_file(data);
				var inserted = self.tags.insert({
					hash:  hash,
					key:   tag.key,
					value: tag.value,
					'key/value': hash+'¹'+tag.key+'²'+tag.value,
					auto:  !!tag.auto
				});
				if (inserted && callback) { callback(); }
			});
		}
		,
		get_untagged: function(){
			var self = this;
			var untagged = [];
			var files = self.files.data;
			self.files.data.forEach(function(obj, i){
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
			self.files.data.forEach(function(obj, i){
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
		get_keys: function(){
			var mapper = function(obj, i, coll){ return obj.key; };
			var reducer = function(array, values) {
				var distinct = [];
				array.forEach(function(key, i){
					if (distinct.indexOf(key) == -1) { distinct.push(key); }
				});
				return distinct.sort()
			}
			return this.tags.mapReduce(mapper, reducer);
		}
		,
		get_values: function(key){
			var distinct = [];
			var values = this.tags.find({'key': key});
			values.forEach(function(obj, i){
				if (distinct.indexOf(obj.value) == -1) { distinct.push(obj.value); }
			});
			return distinct.sort();
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
		this.set('untagged', Database.get_untagged() );
		this.set('verified', Database.get_verified_files() );
	};
	
	var Processing = new Ractive({
		el: 'processing',
		template: '#processing-tpl',
		data: {
		}
	});
	Processing.on({
		index: function(){ /* TODO */ },
		rename: function(){ /* TODO */ }
	});


	
	$('#save_db').on('click', function(){ Database.db.saveDatabase(); });
	
	var EditableSelect = Ractive.extend({
		isolated: true,
		template:
			'<div class="es">'+
				'<input type="text" class="es-input form-control" value="{{value}}" autocomplete="off" on-input-keydown="on_key" on-input-keyup="filter" on-blur="hide_list" on-focus="show_list" />'+
				'<span class="es-clear {{value ? \'show\' : \'hide\'}} text-danger" on-click="clear">×</span>'+
				'<ul class="es-list dropdown-menu {{list_visible ? \'show\' : \'hide\'}}">'+
					'{{#list:i}}<li class="{{visible[i] ? \'show\' : \'hide\' }} {{active==i ? \'active\' : \'\' }}">'+
						'<a href="#" on-click="select_li">{{.}}</a>'+
					'</li>{{/list}}'+
				'</ul>'+
			'</div>',
		oninit: function(){
			var self = this;
			self.set({
				visible: [],
				active: -1,
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
							console.log('↓',a);
							while (a<l && !self.get('visible.'+a)) { a++; console.log(a,'+'); }
							self.set('active', (a+1)%l); console.log(a+1,'!');
							break;
						case 13: // Enter
							e.original.preventDefault();
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
					var search = self.get('value').toLowerCase().trim();
					var first = self.get('active') >=0 ? self.get('active') : -1;
					for (var i=0; i<list.length; i++){
						var found = (list[i] || '').toLowerCase().indexOf(search) >= 0;
						self.set('visible.'+i, found);
						if (found && first==-1) { self.set('active', i); first = i; }
					}
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
			values: []
		},
		components: {
			myselect: EditableSelect
		}
	});
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
	$('#dropzone-db').on('drop', function(e){
		var files = e.originalEvent.dataTransfer.files;
		for (var i = 0; i < files.length; ++i){
			var filepath = files[i].path;
			Database.add_file(filepath, function(){
				ViewDB.update_stats();
			});
		}
		return false;
	});
	$('#dropzone-tags').on('drop', function(e){
		var files = e.originalEvent.dataTransfer.files;
		for (var i = 0; i < files.length; ++i){
			var filepath = files[i].path;
			Database.add_tag(filepath, {key: Tagger.get('key'), value: Tagger.get('value'), auto: false}, function(){
				ViewDB.update_stats();
				Tagger.update_tags_keys().then(function(){
					Tagger.update_tags_values();
				});
			});
		}
		return false;
	});
	
	Database.init().then(function(){
		ViewDB.update_stats();
		Tagger.update_tags_keys().then(function(){
			Tagger.update_tags_values();
		});
	});
});
