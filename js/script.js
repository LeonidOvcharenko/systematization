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
				self.tags  = self.db.getCollection('tags') || self.db.addCollection('tags', {indices: ['key']});
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
				if (inserted) { callback(); }
			});
		}
		,
		get_hash_from_db: function(filepath){
			return self.files.findOne({'path': { '$eq' : filepath }});
		}
		,
		add_tag: function(data, callback){
			var self = this;
			self.tags.insert({
				hash:  data.hash,
				key:   data.key,
				value: data.value,
				auto:  !!data.auto
			});
			if (callback) { callback(); }
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
					!self.tags.findOne({'$and': [{ 'hash': obj.hash }, { 'auto': false }]})
					&&
					self.tags.findOne({'$and': [{ 'hash': obj.hash }, { 'auto': true }]})
				) {
					verified.push(obj);
				}
			});
			return verified;
		}
		,
		/*
		get_keys: function(){
			var self = this;
			var mapper = function(){
				if (!this.fruits) return;
				for (var fruit in this.fruits) {
					emit(fruit, {this.fruits[fruit]: 1});
				}
			};
			var reducer = function(key, values) {
				var colors = {};
				values.forEach(function(v) {
					for (var k in v) { // iterate colors
						if (!colors[k]) colors[k] = 0;
						color[k] += v[k];
					}
				});
				return colors;
			}
			return self.tags.mapReduce(mapper, reducer);
		}
		,*/
		get_values: function(key){
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

	// Display some statistic about this computer, using node's os module.
	var os = require('os');
	var prettyBytes = require('pretty-bytes');

	$('.stats').append('Number of cpu cores: <span>' + os.cpus().length + '</span>');
	$('.stats').append('<br>');
	$('.stats').append('Free memory: <span>' + prettyBytes(os.freemem())+ '</span>');


	Database.init().then(function(){
		ViewDB.update_stats();
	});
	
	// read file from dropzone
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
	
	$('#save_db').on('click', function(){ Database.db.saveDatabase(); });
	
	var EditableSelect = Ractive.extend({
		isolated: true,
		template: '<input type="text" class="es-input form-control" value="{{value}}" autocomplete="off" on-input-keydown="on_key" on-input-keyup="filter" on-blur="hide_list" on-focus="show_list">'+
			'<ul class="es-list dropdown-menu {{list_visible ? \'show\' : \'hide\'}}">'+
			'{{#list:i}}<li class="{{visible[i] ? \'show\' : \'hide\' }}"><a href="#" on-click="select_li">{{.}}</a></li>{{/list}}'+
			'</ul>',
		/* data: {
			list: ['A', 'B', 'C'],
			value: 'test',
			filter: false
		}, */
		oninit: function(){
			var self = this;
			self.set({
				visible: [],
				list_visible: false
			});
			self.on({
				'select_li': function(e){
					e.original.preventDefault();
					self.set('value', e.context);
				},
				'show_list': function(e){
					var $input = $(e.node);
					$input.next()
					.css({
						top:   $input.position().top + $input.outerHeight() - 1,
						left:  $input.position().left,
						width: $input.outerWidth()
					})
					self.set('list_visible', true);
					self.fire('filter');
				},
				'hide_list': function(e){
					setTimeout(function(){ self.set('list_visible', false); }, 100);
				},
				'on_key': function(e){
					switch (e.original.keyCode) {
						case 38: // Up
							// var visibles = that.es.$list.find('li.es-visible');
							// var selected = visibles.index(visibles.filter('li.selected')) || 0;
							// that.highlight(selected - 1);
							break;
						case 40: // Down
							// var visibles = that.es.$list.find('li.es-visible');
							// var selected = visibles.index(visibles.filter('li.selected')) || 0;
							// that.highlight(selected + 1);
							break;
						case 13: // Enter
							// if (that.es.$list.is(':visible')) {
							// 	that.es.select(that.es.$list.find('li.selected'));
							// 	e.original.preventDefault();
							// }
						case 9:  // Tab
						case 27: // Esc
							self.fire('hide_list');
							break;
						default:
							// that.es.filter();
							// that.highlight(0);
							break;
					}
				},
				'filter': function(){
					var self = this;
					var list = self.get('list');
					var search = self.get('value').toLowerCase().trim();
					for (var i=0; i<list.length; i++){
						var found = list[i].toLowerCase().indexOf(search) >= 0;
						self.set('visible.'+i, found);
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
			key_selected: '',
			keys: [],
			value: '',
			value_selected: '',
			values: []
		},
		components: {
			myselect: EditableSelect
		}
	});
	Tagger.set({keys: ['Автор', 'Тип', 'Artist', 'Album', 'BPM']});
	Tagger.set({values: ['Алексеев', 'Амосов', 'Фурсов']});
	Tagger.set({value: 'test11'});
});

