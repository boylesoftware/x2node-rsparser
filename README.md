# X2 Framework for Node.js | Result Set Parser

This module provides a parser for parsing SQL SELECT query result sets into complex data structures supported by JSON. The module is a part of X2 Framework.

The concept behind this parser is yet another take at the problem of mapping rigidly two-dimensional grids of values that are results produced by SQL SELECT queries into richly hierarchical, tree-like data structures, with which applications normally operate. The idea is to use particularly structured result sets with special syntax in the result set column labels that maps the column values to certain properties in the produced records on one hand. On the other hand, the parser is provided with the description of the supported records structure via the use of X2 Framework's [x2node-records](https://www.npmjs.com/package/x2node-records) module. The parser then can be fed with the result set rows one by one and build an array of the extracted records. In the simplest case, each row in the result set represents a single record of the given type and each column's label is the name of the record property, to which the column value maps. The parser implementation, however, supports far more complex cases including multiple levels of nested objects, polymorphic objects, reference properties and simulteneous fetch of the referred records, arrays and maps.

## Usage

The module exports a single class `RSParser`. An instance of the `RSParser` class can be configured once for a specific result set structure and then used to parse one result set at a time, accumulating extracted records in an internal array. Here is a simple example that uses [mysql](https://www.npmjs.com/package/mysql):

```javascript
const mysql = require('mysql');
const RecordTypesLibrary = require('x2node-records');
const RSParser = require('x2node-rsparser');

// create record types library
const recordTypes = new RecordTypesLibrary({
	'Person': {
		properties: {
			'id': {
				valueType: 'number',
				role: 'id'
			},
			'firstName': {
				valueType: 'string'
			},
			'lastName': {
				valueType: 'string'
			}
		}
	}
});

// create parser to extract Person records
const parser = new RSParser(recordTypes, 'Person');

// connect to the database
const connection = mysql.createConnection({
	host: 'localhost',
	user: 'me',
	password: 'secret',
	database: 'my_db'
});
connection.connect(function(err) {
	if (err)
		throw err;
});

// create and run the query
connection.query(
	'SELECT id, fname AS firstName, lname AS lastName FROM persons'
)
.on('error', function(err) {
	throw err;
})
.on('fields', function(fields) {

	// configure the parser with the columns markup
	parser.init(fields.map(field => field.name));
})
.on('result', function(row) {

	// feed the row to the parser
	parser.feedRow(row);
})
.on('end', function() {

	// end connection to the database
	connection.end();

	// print extracted records
	console.log(JSON.stringify(parser.records));
});
```

The `RSParser` constructor takes two arguments: the application's record types library and the name of the record type being extracted from the result set.

Note the first requirement to the result set structure: *the first column of the result set must always be the record id*.

Then note how the parser is initialized in the `fields` event handler where it's fed with an array containing the property names for each result set column. The property names are specified as column labels in the SELECT query.

In the `result` event handler we feed the parser with the received result set rows.

When the query execution is complete, in the `end` event handler we have an array with extracted records available in the parser's `records` property.

## The API

The `RSParser` exposes the following properties and methods:

* `new RSParser(recordTypes, topRecordTypeName, [options])` - The constructor used to create a new parser. The first argument is an instance of `RecordTypesLibrary` provided by the [x2node-records](https://www.npmjs.com/package/x2node-records) module. The second argument is a string that specifies the name of the record type extracted bu the parser from the result set. The optional third argument is an object with options. At the moment, the parser itself only uses `valueExtractors` option discussed later in this section, but the options object is made available to any parser customization points and can be used to configure those.

  Note, that before a new parser instance can be used, it must be initialized with the result set column labels called the *columns markup*.

* `init(markup)` - Initialize the parser with columns markup. The markup is normally extracted from the result set column labels. The `markup` argument is an array of strings, one string per result set column. The markup syntax is discussed in detail later in this manual. Once the parser is initialized, result set rows can start to be fed to it for parsing.

* `feedRow(row)` - Feed a result set row to the parser. The `row` argument can be either an array of corresponding column values, or an object with keys being column labels (which are the column markup) and values being the corresponding values. Using array yields slightly better performance.

* `reset()` - Reset the parser so it can be used again for the same query. The reset does not erase the markup, so once the parser is initialized, it can only be used for the same result set structure. The reset only clears the perser's internal state and the accumulated records collections.

* `records` - A read-only property, which is an array of extracted records. Normally, it is accessed after all of the result set rows are fed to the parser. The `reset()` method creates a new instance of the array, so that the reference to the previous parsing results can still be used outside of the parser.

* `referredRecords` - The parser supports fetching records referred to by reference properties, all within the same result set as discussed later in this manual. The extracted referred records end up in this read-only property, which is an object with keys being the reference values (record type, hash sign, record id) and values being the record objects. It is a parsing result collection supplementary to the `records` property. The `reset()` method create a new instance of the referred records collection.

* `merge(otherParser)` - Merge `records` and `referredRecords` in the specified other parser into this one. The `otherParser` must be an instance of `RSParser` containing the same number of records of the same record type with the same ids and in the same order. Merging multiple parsers is used primarily to support loading data structures with multiple multi-element tree branches (having multiple array and/or map properties on the same nesting level). This topic is discussed later in this manual.

When the `feedRow(row)` method is called, the values in the provided `row` argument are considered "raw". Before a value from a result set column is set into the corresponding record property it is passed through a function called *value extractor*. The default value extractors can be overridden by providing custom extraction functions for the extractor types in the parser constructor's `options` argument. The option used for that is `valueExtractors`. The keys are extractor types and the values are corresponding extractor functions. The following extractor types are used:

* `string` - Used to extract string record properties. The default extractor simply returns the value from the provided `row` argument.
* `number` - Used to extract number record properties. The default extractor simply returns the value from the provided `row` argument.
* `boolean` - Used to extract Boolean record properties. The default extractor returns `null` if the raw value is `null`, otherwise it returns the result of `rawValue ? true : false` conditional operator.
* `datetime` - Used to extract datetime record properties. The default extractor simply returns the value from the provided `row` argument.
* `isNull` - Special extractor used to test if the property value is `null`. The default extractor returns `true` if the raw value is `null`, or `false` if it is not.

The extractor functions receive the following arguments:

* `rawVal` - The raw value from the `row` argument provided to the `feedRow(row)` method.
* `rowNum` - Zero-based result set row number.
* `colNum` - Zero-based result set column number.
* `options` - The options object originally passed to the parser constructor.

For example, if the database returns numbers as strings, a customer extractor could be used to fix that:

```javascript
const parser = new RSParser(recordTypes, 'Person', {
	valueExtractors: {
		'number': function(rawVal) {
			return (rawVal === null ? null : Number(rawVal));
		}
	}
});
```

## The Columns Markup

TODO
