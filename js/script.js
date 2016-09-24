$(function(){
	var FS     = require('fs');
	var Crypto = require('crypto');
	var Loki   = require('lokijs');
	var FilesDB = {
		init: function(){
			var self = this;
			var db_loader = function(){
				self.files = self.db.getCollection('files') || self.db.addCollection('files', {unique: ['hash']});
				self.tags  = self.db.getCollection('tags') || self.db.addCollection('tags', {indices: ['key']});
			};
			self.db = new Loki('files.json', {
				autoload: true, autoloadCallback: db_loader,
				autosave: true, autosaveInterval: 5000
			});
		}
		,
		hash_file: function(data){
			return Crypto.createHash('sha1').update(data).digest('hex');
		}
		,
		add_file: function(filepath){
			var self = this;
			FS.readFile(filepath, function(err, data){
				var hash = self.hash_file(data);
				self.files.insert({
					path: filepath,
					hash: hash
				});
			});
		}
		,
		get_hash_from_db: function(filepath){
			return self.files.findOne({'path': { '$eq' : filepath }});
		}
		,
		add_tag: function(key,value,filehash){
			var self = this;
			self.tags.insert({
				hash: filehash,
				key: key,
				value: value
			});
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
	
	

	// Display some statistic about this computer, using node's os module.
	var os = require('os');
	var prettyBytes = require('pretty-bytes');

	$('.stats').append('Number of cpu cores: <span>' + os.cpus().length + '</span>');
	$('.stats').append('Free memory: <span>' + prettyBytes(os.freemem())+ '</span>');


	FilesDB.init();
	
	// read file from dropzone
	$(window).on('dragover drop', function(e){ e.preventDefault(); return false; });
	$('.dropzone')
	.on('dragover', function(e){
		$(this).addClass('hover');
		return false;
	}).on('dragleave', function(e){
		$(this).removeClass('hover');
		return false;
	}).on('drop', function(e){
		e.preventDefault();
		var files = e.originalEvent.dataTransfer.files;
		for (var i = 0; i < files.length; ++i){
			var filepath = files[i].path;
			FilesDB.add_file(filepath);
		}
		$(this).removeClass('hover');
		return false;
	});
	
	$('#save_db').on('click', function(){ FilesDB.db.saveDatabase(); });
	
	var EditableSelect = Ractive.extend({
		isolated: true,
		template: '<input type="text" class="es-input" value="{{value}}" autocomplete="off" on-input-keydown="on_key" on-input-keyup="filter" on-blur="hide_list" on-focus="show_list">'+
			'<ul class="es-list" style="display:{{list_visible ? \'block\' : \'none\'}};">'+
			'{{#list:i}}<li class="{{visible[i] ? \'visible\' : \'\' }} {{hl[i] ? \'hl\' : \'\' }}" on-click="select_li" on-mouseover="hl:{{true}},{{i}}" on-mouseout="hl:{{false}},{{i}}">{{.}}</li>{{/list}}'+
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
				hl: [],
				list_visible: false
			});
			self.on({
				'select_li': function(e){
					self.set('value', e.context);
				},
				'hl': function(e, hl, i){
					self.set('hl.'+i, hl);
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
		template: $('#tagger-tpl').html(),
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

