import { pascalCase, sentenceCase } from "change-case";
import { Code, code } from "ts-poet";
import {
  GraphQLEnumType,
  GraphQLField,
  GraphQLList,
  GraphQLNamedType,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLScalarType,
  GraphQLSchema,
} from "graphql";
import { PluginFunction, Types } from "@graphql-codegen/plugin-helpers";
import PluginOutput = Types.PluginOutput;

interface PluginConfig {
  enumsAsTypes?: boolean;
}

/** Generates `newProject({ ... })` factory functions in our `graphql-types` codegen output. */
export const plugin: PluginFunction<PluginConfig> = async (schema, documents, config) => {
  const chunks: Code[] = [];
  generateFactoryFunctions(schema, chunks, config);
  generateEnumDetailHelperFunctions(schema, chunks);
  addNextIdMethods(chunks);
  const content = await code`${chunks}`.toStringWithImports();
  return { content } as PluginOutput;
};

function generateFactoryFunctions(schema: GraphQLSchema, chunks: Code[], config: PluginConfig) {
  Object.values(schema.getTypeMap()).forEach(type => {
    if (shouldCreateFactory(type)) {
      chunks.push(newFactory(type, config));
    }
  });
}

/** Makes helper methods to convert the "maybe enum / maybe enum detail" factory options into enum details. */
function generateEnumDetailHelperFunctions(schema: GraphQLSchema, chunks: Code[]) {
  const usedEnumDetailTypes = new Set(
    Object.values(schema.getTypeMap())
      .filter(shouldCreateFactory)
      .flatMap(type => {
        return Object.values(type.getFields())
          .map(f => unwrapNotNull(f.type))
          .filter(isEnumDetailObject);
      }),
  );

  usedEnumDetailTypes.forEach(type => {
    const enumType = getRealEnumForEnumDetailObject(type);
    chunks.push(code`
        const enumDetailNameOf${enumType.name} = {
          ${enumType
            .getValues()
            .map(v => `${v.value}: "${sentenceCase(v.value)}"`)
            .join(", ")}
        };

        // The enumOrDetailOf will probably not be Partial, but mark it to play nicely with DeepPartial
        function enumOrDetailOf${enumType.name}(enumOrDetail: Partial<${type.name}> | ${enumType.name} | undefined): ${
      type.name
    } {
          if (enumOrDetail === undefined) {
            return new${type.name}();
          } else if (Object.keys(enumOrDetail).includes("code")) {
            return enumOrDetail as ${type.name};
          } else {
            return new${type.name}({
              code: enumOrDetail as ${enumType.name},
              name: enumDetailNameOf${enumType.name}[enumOrDetail as ${enumType.name}],
            });
          }
        }
      `);
  });
}

/** Creates a `new${type}` function for the given `type`. */
function newFactory(type: GraphQLObjectType, config: PluginConfig): Code {
  // We want to allow callers to pass in simple enums for our FooEnumDetails pattern,
  // so find those fields and add type unions to the actually-the-enum type.
  const enumFields = Object.values(type.getFields()).filter(field => isEnumDetailObject(unwrapNotNull(field.type)));

  // For each enum field, we allow passing either the enum or enum detail to the factory
  const enumOverrides = enumFields.map(field => {
    const realEnumName = getRealEnumForEnumDetailObject(field.type).name;
    const detailName = (unwrapNotNull(field.type) as GraphQLObjectType).name;
    return `{ ${field.name}?: ${realEnumName} | Partial<${detailName}> }`;
  });

  const typeName = pascalCase(type.name);

  // Take out the enum fields, and put back in their `enum | enum detail` type unions
  const basePartial =
    enumFields.length > 0 ? `Omit<${typeName}, ${enumFields.map(f => `"${f.name}"`).join(" | ")}>` : typeName;
  const maybeEnumOverrides = enumOverrides.length > 0 ? ["", ...enumOverrides].join(" & ") : "";

  return code`
    export type ${typeName}Options = Partial<${basePartial}> ${maybeEnumOverrides};

    export function new${typeName}(options: ${typeName}Options = {}, cache: Record<string, any> = {}): ${typeName} {
      const o = cache["${typeName}"] = {} as ${typeName};
      o.__typename = '${type.name}';
      ${Object.values(type.getFields()).map(f => {
        if (f.type instanceof GraphQLNonNull) {
          const fieldType = f.type.ofType;
          if (isEnumDetailObject(fieldType)) {
            const enumType = getRealEnumForEnumDetailObject(fieldType);
            return `o.${f.name} = enumOrDetailOf${enumType.name}(options.${f.name});`;
          } else if (fieldType instanceof GraphQLList) {
            // If this is a list of objects, initialize it as normal, but then also probe it to ensure each
            // passed-in value goes through `maybeNewFoo` to ensure `__typename` is set, otherwise Apollo breaks.
            if (fieldType.ofType instanceof GraphQLObjectType) {
              const objectType = fieldType.ofType.name;
              return `o.${f.name} = (options.${f.name} ?? []).map(i => maybeNewOrNull${objectType}(i, cache));`;
            } else if (
              fieldType.ofType instanceof GraphQLNonNull &&
              fieldType.ofType.ofType instanceof GraphQLObjectType
            ) {
              const objectType = fieldType.ofType.ofType.name;
              return `o.${f.name} = (options.${f.name} ?? []).map(i => maybeNew${objectType}(i, cache));`;
            } else {
              return `o.${f.name} = options.${f.name} ?? [];`;
            }
          } else if (fieldType instanceof GraphQLObjectType) {
            return `o.${f.name} = maybeNew${fieldType.name}(options.${f.name}, cache);`;
          } else {
            return `o.${f.name} = options.${f.name} ?? ${getInitializer(type, f, fieldType, config)};`;
          }
        } else if (f.type instanceof GraphQLObjectType) {
          return `o.${f.name} = maybeNewOrNull${f.type.name}(options.${f.name}, cache);`;
        } else {
          return `o.${f.name} = options.${f.name} ?? null;`;
        }
      })}
      return o;
    }
    
    function maybeNew${typeName}(value: ${typeName}Options | undefined, cache: Record<string, any>): ${typeName} {
      if (value === undefined) {
        return cache["${typeName}"] as ${typeName} ?? new${typeName}({}, cache)
      } else if (value.__typename) {
        return value as ${typeName};
      } else {
        return new${typeName}(value, cache);
      }
    }
    
    function maybeNewOrNull${typeName}(value: ${typeName}Options | undefined | null, cache: Record<string, any>): ${typeName} | null {
      if (!value) {
        return null;
      } else if (value.__typename) {
        return value as ${typeName};
      } else {
        return new${typeName}(value, cache);
      }
    }
    `;
}

/** Returns a default value for the given field's type, i.e. strings are "", ints are 0, arrays are []. */
function getInitializer(
  object: GraphQLObjectType,
  field: GraphQLField<any, any, any>,
  type: GraphQLOutputType,
  config: PluginConfig,
): string {
  if (type instanceof GraphQLList) {
    // We could potentially make a dummy entry in every list, but would we risk infinite loops between parents/children?
    return `[]`;
  } else if (type instanceof GraphQLEnumType) {
    return config.enumsAsTypes
      ? `"${type.getValues()[0].value}"`
      : `${type.name}.${pascalCase(type.getValues()[0].value)}`;
  } else if (type instanceof GraphQLScalarType) {
    if (type.name === "Int") {
      return `0`;
    } else if (type.name === "Boolean") {
      return `false`;
    } else if (type.name === "String") {
      const maybeCode = isEnumDetailObject(object) && object.getFields()["code"];
      if (maybeCode) {
        const value = getRealEnumForEnumDetailObject(object).getValues()[0].value;
        return `"${sentenceCase(value)}"`;
      } else {
        return `"${field.name}"`;
      }
    } else if (type.name === "ID") {
      return `nextFactoryId("${object.name}")`;
    }
    // TODO Handle other scalars like dates/etc
    return `"" as any`;
  }
  return `undefined as any`;
}

/** Look for the FooDetail/code/name pattern of our enum detail objects. */
function isEnumDetailObject(object: GraphQLOutputType): object is GraphQLObjectType {
  return (
    object instanceof GraphQLObjectType &&
    object.name.endsWith("Detail") &&
    Object.keys(object.getFields()).length === 2 &&
    !!object.getFields()["code"] &&
    !!object.getFields()["name"]
  );
}

function getRealEnumForEnumDetailObject(detailObject: GraphQLOutputType): GraphQLEnumType {
  return unwrapNotNull((unwrapNotNull(detailObject) as GraphQLObjectType).getFields()["code"]!.type) as GraphQLEnumType;
}

function unwrapNotNull(type: GraphQLOutputType): GraphQLOutputType {
  if (type instanceof GraphQLNonNull) {
    return type.ofType;
  } else {
    return type;
  }
}

function shouldCreateFactory(type: GraphQLNamedType): type is GraphQLObjectType {
  return (
    type instanceof GraphQLObjectType &&
    !type.name.startsWith("__") &&
    type.name !== "Mutation" &&
    type.name !== "Query"
  );
}

function addNextIdMethods(chunks: Code[]): void {
  chunks.push(code`
    let nextFactoryIds: Record<string, number> = {};

    export function resetFactoryIds() {
      nextFactoryIds = {};
    }

    function nextFactoryId(objectName: string): string {
      const nextId = nextFactoryIds[objectName] || 1;
      nextFactoryIds[objectName] = nextId + 1;
      return String(nextId);
    }
  `);
}
